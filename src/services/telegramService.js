/**
 * ─── Telegram Alert Service ───────────────────────────────────────────────────
 *
 * TWO-CHANNEL SYSTEM:
 *
 *  ACTION → TELEGRAM_CHAT_ID / the user's own chat
 *    • New listing BUY signals, bearish alerts
 *    • Every alert about a user's OWN positions (stop loss, TPs, targets,
 *      milestones, hold updates). Small milestones + HOLD are sent silently.
 *
 *  INFO   → TELEGRAM_INFO_CHANNEL_ID (shared channel)
 *    • Market-wide signals only (scanner BUY signals, listing broadcasts).
 *    • Never anyone's personal positions — the channel is shared.
 *
 *  If TELEGRAM_INFO_CHANNEL_ID is not set, info alerts fall back to main chat.
 */

const tg = require('../lib/telegram');
const { claimSignal, releaseSignal } = require('./riskService');
const { trackRecordFor, formatTrackRecord } = require('./strategyStats');
const { ACTIVE } = require('../config/strategy');

const actionChat  = () => process.env.TELEGRAM_CHAT_ID;
const infoChannel = () => process.env.TELEGRAM_INFO_CHANNEL_ID;

// ─── Core send helpers ────────────────────────────────────────────────────────

/** ACTION: needs attention. Throws on failure so callers can report it. */
async function sendAction(text, overrideChatId, opts = {}) {
  const chatId = overrideChatId || actionChat();
  if (!tg.isConfigured() || !chatId) {
    console.warn('[Telegram] Missing credentials — skipping action alert');
    return null;
  }
  return tg.sendLong(chatId, text, { ...opts, throwOnError: true });
}

/** INFO: low priority, market-wide. Never throws. */
async function sendInfo(text, overrideChatId) {
  const chatId = overrideChatId || infoChannel() || actionChat();
  if (!tg.isConfigured() || !chatId) {
    console.warn('[Telegram] Missing credentials — skipping info alert');
    return null;
  }
  return tg.sendLong(chatId, text);
}

// Legacy alias
async function _send(text) { return sendAction(text); }

// ─── BUY Signal (v2scan / liveService) → INFO channel ────────────────────────
async function sendBuyAlert(result) {
  if (result.signal !== 'BUY') return;
  if (result.score < 7) return;
  // Same spacing between entries as the backtest assumes (strategy config)
  const gapHours = Math.max(1, Number(ACTIVE.minHoursBetweenEntries) || 4);
  if (!(await claimSignal(result.symbol, 'BUY', gapHours * 3_600_000))) {
    console.log(`[Telegram] Dedup: ${result.symbol} BUY already sent within ${gapHours}h`);
    return;
  }

  const tp1  = result.takeProfits?.tp1;
  const tp2  = result.takeProfits?.tp2;
  const tp3  = result.takeProfits?.tp3;
  const sl   = result.stopLoss;
  const rr   = result.riskReward;
  // Honest context: what signals like this actually did in the backtest
  const track = result.trackRecord !== undefined ? result.trackRecord : trackRecordFor(result.score);

  const lines = [
    `🟢 *BUY SIGNAL — ${result.symbol}*`,
    ``,
    `💰 *Entry:*    \`$${Number(result.price).toFixed(4)}\``,
    sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(4)}\` _(${result.stopAtrMult || 1.5}x ATR)_` : '',
    ``,
    tp1 ? `🎯 *TP1 (sell 40%):* \`$${Number(tp1.price).toFixed(4)}\` — ${tp1.ratio}` : '',
    tp2 ? `🎯 *TP2 (sell 35%):* \`$${Number(tp2.price).toFixed(4)}\` — ${tp2.ratio}` : '',
    tp3 ? `🎯 *TP3 (sell 25%):* \`$${Number(tp3.price).toFixed(4)}\` — ${tp3.ratio}` : '',
    rr  ? `⚖️ *Risk:Reward:* ${rr}:1` : '',
    ``,
    `📈 *Setup score:* ${result.score}/15 _(how many conditions lined up — not a probability)_`,
    `📊 ${formatTrackRecord(track)}`,
    ``,
    `🔍 *Why:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    ``,
    `⚠️ *After TP1 → move stop to breakeven*`,
    `📝 Quick buy: \`buy ${result.symbol} ${Number(result.price).toFixed(4)}\``,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  const sent = await sendInfo(lines);
  if (!sent) { await releaseSignal(result.symbol, 'BUY'); return; } // let the next run retry
  console.log(`[Telegram] BUY alert sent → INFO — ${result.symbol}`);
}

// ─── New Listing BUY Signal → MAIN CHAT ──────────────────────────────────────
async function sendListingBuyAlert(result) {
  if (result.signal !== 'BUY') return;

  const tp1 = result.takeProfits?.tp1;
  const tp2 = result.takeProfits?.tp2;
  const tp3 = result.takeProfits?.tp3;
  const sl  = result.stopLoss;
  const rr  = result.riskReward;

  const identityLines = [];
  identityLines.push(`🪙 *Coin Name:* ${tg.escapeMd(result.coinName || result.baseAsset)}`);
  identityLines.push(`🔤 *Ticker:* ${tg.escapeMd(result.baseAsset)}`);
  if (result.description) identityLines.push(`📄 *What it is:* ${tg.escapeMd(result.description)}`);

  if (result.contracts && result.contracts.length > 0) {
    identityLines.push(`\n📋 *Contract Addresses:*`);
    result.contracts.forEach(c => {
      identityLines.push(`  *${tg.escapeMd(c.chainLabel)}:*`);
      identityLines.push(`  \`${c.address}\``);
    });
    identityLines.push(`\n⚠️ *Always verify on CoinGecko before buying*`);
  } else if (result.isNativeAsset) {
    identityLines.push(`ℹ️ *Native asset — no contract address (like BTC, ETH, SOL)*`);
  } else {
    identityLines.push(`⚠️ *Contract address not found — verify manually before buying*`);
  }
  if (result.coingeckoUrl) identityLines.push(`🔗 *CoinGecko:* ${result.coingeckoUrl}`);

  const riskLine = result.riskFlags?.length > 0
    ? `⚠️ *Risk Flags:* ${tg.escapeMd(result.riskFlags.join(', '))}`
    : `✅ No major risk flags`;

  const lines = [
    `🚀 *NEW LISTING BUY — ${result.symbol}*`,
    ``,
    ...identityLines,
    ``,
    `── *MARKET DATA* ──`,
    `📊 *24H Change:* ${result.priceChange >= 0 ? '+' : ''}${Number(result.priceChange).toFixed(2)}%`,
    `💵 *Volume:* $${(result.volume / 1e6).toFixed(2)}M`,
    `🔥 *Pump Rating:* ${result.pumpRating} (pump score ${result.pumpScore})`,
    result.earlyStage ? `⚡ *Early Stage* — only ${result.candleCount} candles of history` : '',
    ``,
    `── *TRADE PLAN* ──`,
    `💰 *Entry:*    \`$${Number(result.entryPrice).toFixed(6)}\``,
    sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(6)}\` _(2x ATR)_` : '',
    ``,
    tp1 ? `🎯 *TP1 (sell 40%):* \`$${Number(tp1.price).toFixed(6)}\` — ${tp1.ratio}` : '',
    tp2 ? `🎯 *TP2 (sell 35%):* \`$${Number(tp2.price).toFixed(6)}\` — ${tp2.ratio}` : '',
    tp3 ? `🎯 *TP3 (sell 25%):* \`$${Number(tp3.price).toFixed(6)}\` — ${tp3.ratio}` : '',
    rr  ? `⚖️ *Risk:Reward:* ${rr}:1` : '',
    ``,
    `📐 *Technical Reasons:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    result.warnings?.length > 0 ? `\n⚠️ *Warnings:*` : '',
    ...(result.warnings || []).map(w => `  • ${w}`),
    ``,
    riskLine,
    result.onKraken ? `✅ Also on Kraken — cross-exchange validated` : '',
    ``,
    `🔴 *SELL RULES:*`,
    `  • Stop Loss hit → EXIT 100% immediately`,
    `  • TP1 hit → sell 40%, move stop to breakeven`,
    `  • TP2 hit → sell 35%, trail stop below TP1`,
    `  • TP3 hit → sell remaining 25%`,
    `  • Volume drops below $200K → EXIT`,
    ``,
    `⚠️ *New listings = HIGH RISK. Max 1-2% of account.*`,
    `📝 Quick buy: \`buy ${result.symbol} ${Number(result.entryPrice).toFixed(6)}\``,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await sendAction(lines);
  console.log(`[Telegram] NEW LISTING BUY → MAIN CHAT — ${result.symbol}`);
}

// ─── Bearish Alert → ACTION channel ──────────────────────────────────────────
async function sendBearishAlert(result) {
  if (result.signal !== 'BEARISH_ALERT') return;
  if (result.score < 3) return;
  if (!(await claimSignal(result.symbol, 'BEARISH_ALERT'))) return;

  const lines = [
    `🔴 *BEARISH ALERT — ${result.symbol}*`,
    ``,
    `⚠️ Not a short signal. If you hold ${result.symbol}: check your stop loss.`,
    ``,
    `💰 *Price:* \`$${Number(result.price).toFixed(4)}\``,
    `📉 *Trend:* DOWNTREND (below EMA200)`,
    `📊 *RSI:* ${Number(result.rsi).toFixed(1)}`,
    result.adxValue ? `📐 *ADX:* ${Number(result.adxValue).toFixed(1)}` : '',
    ``,
    `📝 *Signals:*`,
    ...(result.factors || []).map(f => `  • ${f}`),
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  try { await sendAction(lines); }
  catch (err) { await releaseSignal(result.symbol, 'BEARISH_ALERT'); throw err; }
}

// ─── Connection Test ──────────────────────────────────────────────────────────
async function sendTestMessage() {
  if (!tg.isConfigured() || !actionChat()) throw new Error('Telegram credentials not set');
  await sendAction([
    `✅ *CryptoBot V2 Connected*`,
    ``,
    `MAIN CHAT (this chat):`,
    `  • 🚀 New listing BUY signals`,
    `  • 🔴 Stop loss alerts`,
    `  • 🟢 TP1 / TP2 / TP3 hit`,
    `  • 🎯 Target hit + milestones`,
    `  • ⚪ HOLD updates every 4 hours (silent)`,
    `  • 🔴 Bearish alerts`,
    ``,
    `CHANNEL (${infoChannel() || 'not set — add TELEGRAM_INFO_CHANNEL_ID'}):`,
    `  • 🟢 BUY signals from market scanner`,
    `  • 🚀 Listing / moonshot broadcasts`,
  ].join('\n'));
}

// ─── Position Alert (check command / custom callers) ──────────────────────────
async function sendPositionAlert(position, advice, overrideChatId) {
  const chatId = overrideChatId || position.chatId || actionChat();

  const tp1 = advice.tradePlan?.takeProfits?.tp1;
  const tp2 = advice.tradePlan?.takeProfits?.tp2;
  const tp3 = advice.tradePlan?.takeProfits?.tp3;
  const sl  = advice.tradePlan?.stopLoss;

  const emoji = {
    STOP_LOSS: '🔴', TAKE_PROFIT: '🟢', TRAIL_STOP: '🟡', CLOSE_PARTIAL: '🟠', HOLD: '⚪',
  }[advice.recommendation] || '⚪';

  const urgencyLabel = {
    CRITICAL: '🚨 URGENT', HIGH: '⚡ High Priority', MEDIUM: '⚠️ Medium Priority', LOW: 'ℹ️ Low Priority',
  }[advice.urgency] || '';

  const lines = [
    `${emoji} *${advice.recommendation} — ${position.symbol}*  ${urgencyLabel}`,
    ``,
    `💰 *Bought at:* \`$${position.buyPrice}\``,
    `📊 *Now:*       \`$${Number(advice.currentPrice).toFixed(4)}\``,
    `📈 *P&L:*       ${advice.pnlDisplay}`,
    position.quantity ? `💵 *Value:* $${(position.quantity * advice.currentPrice).toFixed(2)}` : '',
    ``,
    `── *What to do* ──`,
    ...(advice.reasons || []).map(r => `  ${r}`),
    ``,
    ...(advice.actions || []).map(a => `  👉 ${a}`),
    ``,
    sl  ? `🛡 *Stop Loss:* \`$${Number(sl).toFixed(4)}\`` : '',
    tp1 ? `🎯 *TP1 (40%):* \`$${Number(tp1.price).toFixed(4)}\`` : '',
    tp2 ? `🎯 *TP2 (35%):* \`$${Number(tp2.price).toFixed(4)}\`` : '',
    tp3 ? `🎯 *TP3 (25%):* \`$${Number(tp3.price).toFixed(4)}\`` : '',
    ``,
    `📐 *RSI:* ${advice.indicators?.rsi || 'N/A'} | *Trend:* ${advice.indicators?.macroTrend || 'N/A'}`,
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');

  await sendAction(lines, chatId);
}

// ─── sendSignalAlert — used by liveService (local runner) ──────────────────────
async function sendSignalAlert(result) {
  if (!result) return;
  if (result.signal === 'BUY')           return sendBuyAlert(result);
  if (result.signal === 'BEARISH_ALERT') return sendBearishAlert(result);
}

module.exports = {
  sendBuyAlert,
  sendBearishAlert,
  sendListingBuyAlert,
  sendTestMessage,
  sendPositionAlert,
  sendSignalAlert,
  sendAction,
  sendInfo,
  _send,
};
