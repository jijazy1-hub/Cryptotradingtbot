/**
 * ─── Quick Price Check ────────────────────────────────────────────────────────
 * GET /api/v2quickcheck?key=CRON_SECRET     (run every 10 min via cron-job.org)
 *
 * Price-only check of custom target and stop loss — no candles, very fast —
 * so a coin that spikes and dumps inside 30 minutes still triggers an alert.
 * v2monitor (every 30 min) handles TPs, milestones and HOLD updates.
 *
 * Fixes:
 *  - Uses the stop loss locked on the position (same one v2monitor uses).
 *  - "Approaching target" now fires once per position instead of every 10 min.
 *  - Alerts go only to the position owner.
 */

const { getAllUsersPositions, updatePosition } = require('../src/services/positionStore');
const { fetchPrice } = require('../src/lib/market');
const tg = require('../src/lib/telegram');
const store = require('../src/lib/redis');
const { mapLimit } = require('../src/lib/concurrency');
const { stopHitWording } = require('../src/services/stopPlan');
const { cors, requireCronKey } = require('../src/lib/auth');
const autoTrader = require('../src/services/autoTrader');
const { getChatIdsWithAccess } = require('../src/services/subscriptionService');
const practice = require('../src/services/practiceService');

/** Practice accounts: same exit plan, play money, real Binance prices. */
async function runPractice(allowed) {
  const cache = new Map();
  let users = 0, messages = 0;
  for (const chatId of await practice.allUsers()) {
    if (!allowed.has(String(chatId)) && chatId !== 'house') continue; // 'house' = the auto-buy forward test
    try {
      const msgs = await practice.syncUser(chatId, cache);
      if (chatId !== 'house') for (const m of msgs) await tg.send(chatId, m, { silent: true });
      users++; messages += msgs.length;
    } catch (err) { console.error('[QuickCheck] practice', chatId, err.message); }
  }
  return { users, messages };
}

const APPROACH_PCT = 5;

function fmtPrice(p) {
  return p < 0.01 ? p.toFixed(8) : p.toFixed(4);
}

/** Pure decision for one position at a given price. */
function evaluateQuick(pos, currentPrice) {
  const pnlPct   = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
  const multiple = currentPrice / pos.buyPrice;
  const priceStr = fmtPrice(currentPrice);
  const coin     = pos.symbol.replace('USDT', '');

  if (pos.targetPrice && !pos.targetHit && currentPrice >= pos.targetPrice) {
    return {
      event: 'TARGET_HIT',
      updates: { targetHit: true },
      text: [
        `🚨🎯🚨 *${pos.targetMultiple}X TARGET HIT — ${pos.symbol}* 🚨🎯🚨`,
        ``,
        `🌕 *SELL NOW — YOUR TARGET HAS BEEN REACHED*`,
        ``,
        `💰 *Bought at:*   \`$${pos.buyPrice}\``,
        `📊 *Now:*         \`$${priceStr}\``,
        `📈 *Your gain:*   +${pnlPct.toFixed(2)}% (${multiple.toFixed(2)}X)`,
        pos.quantity ? `💵 *Est. profit:* $${((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2)}` : '',
        ``,
        `🔴 *DO THIS RIGHT NOW:*`,
        `  1. Open your exchange immediately`,
        `  2. Sell 60% of your position at market price`,
        `  3. Set stop on remaining 40% at your entry ($${pos.buyPrice})`,
        `  4. If price keeps rising → let it run 🚀`,
        `  5. If price drops back → sell the rest`,
        ``,
        `📝 Record your sale: \`sold ${coin} ${pos.buyPrice} ${priceStr}\``,
        `⏰ ${new Date().toUTCString()}`,
      ].filter(Boolean).join('\n'),
    };
  }

  if (pos.stopLossPrice && !pos.stopLossHit && currentPrice <= pos.stopLossPrice) {
    const w = stopHitWording(pos, pnlPct);
    return {
      event: 'STOP_LOSS',
      updates: { stopLossHit: true },
      text: [
        w.title,
        ``,
        `💰 *Bought at:* \`$${pos.buyPrice}\``,
        `🛡 *Stop:*      \`$${fmtPrice(pos.stopLossPrice)}\``,
        `📊 *Now:*       \`$${priceStr}\``,
        w.result,
        ``,
        w.action,
        ``,
        `📝 Record your exit: \`sold ${coin} ${pos.buyPrice} ${priceStr}\``,
        `⏰ ${new Date().toUTCString()}`,
      ].join('\n'),
    };
  }

  if (pos.targetPrice && !pos.targetHit && !pos.approachAlerted) {
    const distPct = ((pos.targetPrice - currentPrice) / currentPrice) * 100;
    if (distPct > 0 && distPct <= APPROACH_PCT) {
      return {
        event: 'APPROACHING_TARGET',
        updates: { approachAlerted: true },
        text: [
          `⚡ *APPROACHING TARGET — ${pos.symbol}*`,
          ``,
          `💰 Bought at: \`$${pos.buyPrice}\``,
          `📊 Now:       \`$${priceStr}\``,
          `🎯 Target:    \`$${fmtPrice(pos.targetPrice)}\` (${pos.targetMultiple}X)`,
          `📏 Distance:  ${distPct.toFixed(1)}% away`,
          ``,
          `Get ready to sell when target hits.`,
          `Open your exchange now so you are ready.`,
        ].join('\n'),
      };
    }
  }

  return null;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronKey(req, res)) return;

  if (!(await store.lock('cryptobot:lock:quickcheck', 120).catch(() => true))) {
    return res.status(200).json({ success: true, skipped: 'previous quickcheck still in progress' });
  }

  try {
    // Only approved users (and paying ones, when paid access is on)
    const allowed = new Set(await getChatIdsWithAccess());
    const practiceRun = await runPractice(allowed).catch(err => ({ error: err.message }));
    const positions = await getAllUsersPositions();
    const active = positions.filter(p =>
      allowed.has(String(p.chatId)) && !p.targetHit && !p.stopLossHit && (p.targetPrice || p.stopLossPrice)
    );

    if (active.length === 0) {
      return res.status(200).json({ success: true, message: 'No active targets to check', practice: practiceRun, checkedAt: new Date().toISOString() });
    }

    // Group by coin + exchange to avoid duplicate price fetches
    const symbolMap = {};
    for (const pos of active) {
      const key = `${pos.symbol}|${pos.exchange || ''}`;
      (symbolMap[key] = symbolMap[key] || []).push(pos);
    }

    // Prices for all coins, 6 at a time, each from its position's own exchange
    const keys = Object.keys(symbolMap);
    const prices = await mapLimit(keys, 6, (key) => {
      const [sym, exchange] = key.split('|');
      return fetchPrice(sym, { exchange: exchange || null });
    });

    const results = [];
    for (const [k, key] of keys.entries()) {
      const list = symbolMap[key];
      const symbol = key.split('|')[0];
      const currentPrice = prices[k];
      if (!currentPrice) { results.push({ symbol, error: 'Could not fetch price' }); continue; }

      for (const pos of list) {
        const outcome = evaluateQuick(pos, currentPrice);
        if (!outcome) continue;
        await tg.send(pos.chatId, outcome.text);
        await updatePosition(pos.chatId, pos.positionId, outcome.updates);
        // Automated exits act straight away on a stop or target hit
        const auto = outcome.event === 'APPROACHING_TARGET' ? null
          : await autoTrader.sync(pos.chatId, pos.positionId, { price: currentPrice }).catch(err => ({ error: err.message }));
        results.push({ symbol, positionId: pos.positionId, event: outcome.event, price: currentPrice, ...(auto ? { auto: auto.actions, autoError: auto.error } : {}) });
      }
    }

    return res.status(200).json({
      success:   true,
      checked:   active.length,
      symbols:   keys.length,
      alerts:    results.filter(r => r.event),
      errors:    results.filter(r => r.error),
      practice:  practiceRun,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[QuickCheck]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    await store.del('cryptobot:lock:quickcheck').catch(() => {});
  }
};

module.exports.evaluateQuick = evaluateQuick;
