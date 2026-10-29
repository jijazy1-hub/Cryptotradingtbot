/**
 * ─── New Listings Auto-Alert ──────────────────────────────────────────────────
 * GET /api/v2listings-alert
 *
 * Hit by cron-job.org every 30 minutes:  /api/v2listings-alert?key=CRON_SECRET
 * Broadcasts new listings to ALL approved users automatically.
 *
 * TWO-CHANNEL SYSTEM:
 *  All listings go to INFO channel (TELEGRAM_INFO_CHANNEL_ID) — low priority.
 *  Your main bot chat stays clean for ACTION alerts only.
 *  If INFO channel is not configured, listings go to main chat as fallback.
 *
 * DEDUPLICATION:
 *  Each alerted coin is cached for 24 hours — same coin never spams twice.
 *
 * CONTRACT ADDRESSES:
 *  Every alert includes the contract address for every chain from CoinGecko.
 */

const { getMoonshots, getNewListingsWithMetadata } = require('../src/services/listingsService');
const { getChatIdsWithAccess } = require('../src/services/subscriptionService');
const store = require('../src/lib/redis');
const tg = require('../src/lib/telegram');
const { cors, requireCronKey } = require('../src/lib/auth');

// ─── Alert cache (24h dedup, persisted in Redis) ──────────────────────────────
const CACHE_KEY   = 'cryptobot:listed-alerts';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function getAlertedCache() {
  try { return (await store.getJSON(CACHE_KEY, {})) || {}; }
  catch { return {}; }
}

async function saveAlertedCache(cache) {
  try { await store.setJSON(CACHE_KEY, cache); }
  catch (e) { console.error('[ListingsAlert] Cache save error:', e.message); }
}

function isAlreadyAlerted(cache, symbol) {
  const ts = cache[symbol];
  return !!ts && (Date.now() - ts) < COOLDOWN_MS;
}

// ─── Broadcast listing to INFO channel (or fallback to all user chats) ────────
// Listings are market-wide and LOW PRIORITY — they go to the shared info channel.
async function broadcastListing(text) {
  const infoChannel = process.env.TELEGRAM_INFO_CHANNEL_ID;
  if (infoChannel) {
    await tg.sendLong(infoChannel, text);
    return;
  }
  // Fallback: no info channel configured → send silently to every user
  for (const chatId of await getChatIdsWithAccess()) {
    await tg.sendLong(chatId, text, { silent: true });
    await tg.sleep(300);
  }
}

// ─── Format price ─────────────────────────────────────────────────────────────
function fmtPrice(p) {
  if (!p) return 'N/A';
  if (p < 0.000001) return p.toFixed(10);
  if (p < 0.0001)   return p.toFixed(8);
  if (p < 0.01)     return p.toFixed(6);
  if (p < 1)        return p.toFixed(4);
  return p.toFixed(2);
}

// ─── Build alert message for one coin ────────────────────────────────────────
function buildListingMessage(coin, type) {
  const meta     = coin.meta;
  const price    = meta?.currentPrice || coin.price;
  const symbol   = coin.base || coin.symbol;
  const name     = tg.escapeMd(meta?.name || symbol || 'Unknown');
  const change   = coin.change24h ?? coin.priceChange24h;
  const vol      = coin.volume    || coin.volume24h;
  const mcap     = meta?.marketCap;
  const priceStr = fmtPrice(price);

  // ── Contract addresses (always shown) ──────────────────────────────────
  const contracts = meta?.contracts || [];
  let contractBlock;
  if (contracts.length > 0) {
    const lines = ['📋 *Contract Addresses:*'];
    contracts.forEach(ct => {
      lines.push(`  *${tg.escapeMd(ct.chainLabel)}:*`);
      lines.push(`  \`${ct.address}\``);
    });
    lines.push(`⚠️ _Verify on CoinGecko before buying_`);
    contractBlock = lines.join('\n');
  } else if (meta?.isNativeAsset) {
    contractBlock = `ℹ️ _Native asset — no contract address (like BTC or SOL)_`;
  } else {
    contractBlock = `⚠️ _Contract address not found — verify on CoinGecko manually_`;
  }

  // ── Probability line (for moonshots) ───────────────────────────────────
  const probLine = coin.probability
    ? `\n📊 *Score:* ${coin.probability}/92 — ${coin.band} _(heuristic, not backtested)_`
    : '';

  // ── Green signals ───────────────────────────────────────────────────────
  const signals     = (coin.greenSignals || []).slice(0, 3);
  const signalBlock = signals.length > 0
    ? `\n✅ *Why it looks good:*\n${signals.map(s => `  • ${s}`).join('\n')}`
    : '';

  // ── Red flags ───────────────────────────────────────────────────────────
  const flags     = (coin.redFlags || []).slice(0, 2);
  const flagBlock = flags.length > 0
    ? `\n⚠️ *Watch out:*\n${flags.map(f => `  • ${f}`).join('\n')}`
    : '';

  // ── Description ─────────────────────────────────────────────────────────
  const desc = meta?.description
    ? `\n📄 _${tg.escapeMd(meta.description.slice(0, 120))}_`
    : '';

  // ── Targets ─────────────────────────────────────────────────────────────
  const t2x = price ? fmtPrice(price * 2) : null;
  const t5x = price ? fmtPrice(price * 5) : null;

  const headers = {
    moonshot: `🌕 *MOONSHOT ALERT — ${name} (${symbol})*`,
    listing:  `🚀 *NEW LISTING — ${name} (${symbol})*`,
    trending: `🌊 *TRENDING NOW — ${name} (${symbol})*`,
  };

  return [
    headers[type] || `🚀 *NEW — ${name} (${symbol})*`,
    ``,
    `💰 *Price:*   \`$${priceStr}\``,
    change != null ? `📈 *24H:*    ${change >= 0 ? '+' : ''}${Number(change).toFixed(2)}%` : '',
    vol   != null  ? `💵 *Volume:* $${(Number(vol) / 1e6).toFixed(2)}M`                    : '',
    mcap           ? `🏦 *MCap:*   $${(mcap / 1e6).toFixed(1)}M`                           : '',
    probLine,
    desc,
    ``,
    contractBlock,
    signalBlock,
    flagBlock,
    ``,
    t2x ? `🎯 *Targets:*  2X → \`$${t2x}\`  |  5X → \`$${t5x}\`` : '',
    price ? `\n📝 Quick buy: \`buy ${symbol} ${priceStr} 2x\`` : '',
    meta?.cgUrl ? `🔗 ${meta.cgUrl}` : '',
    `⏰ ${new Date().toUTCString()}`,
  ].filter(Boolean).join('\n');
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronKey(req, res)) return;

  try {
    const cache   = await getAlertedCache();
    const alerted = [];
    const skipped = [];

    // ── Scan 1: High-probability moonshots ────────────────────────────────
    let moonshots = [];
    try { moonshots = await getMoonshots(); }
    catch (e) { console.error('[ListingsAlert] Moonshots failed:', e.message); }

    for (const coin of moonshots) {
      const symbol = coin.base || coin.symbol;
      if (!symbol) continue;
      if (isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      await broadcastListing(buildListingMessage(coin, 'moonshot'));
      cache[symbol] = Date.now();
      alerted.push(symbol);
      await tg.sleep(500);
    }

    // ── Scan 2: New listings + CoinGecko trending ─────────────────────────
    let hotCoins = [], trending = [];
    try { ({ hotCoins, trending } = await getNewListingsWithMetadata()); }
    catch (e) { console.error('[ListingsAlert] New listings failed:', e.message); }

    for (const coin of hotCoins) {
      const symbol = coin.base || coin.symbol;
      if (!symbol || isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      await broadcastListing(buildListingMessage(coin, 'listing'));
      cache[symbol] = Date.now();
      alerted.push(symbol);
      await tg.sleep(500);
    }

    for (const coin of trending) {
      const symbol = coin.symbol;
      if (!symbol || isAlreadyAlerted(cache, symbol)) { skipped.push(symbol); continue; }

      await broadcastListing(buildListingMessage(coin, 'trending'));
      cache[symbol] = Date.now();
      alerted.push(symbol);
      await tg.sleep(500);
    }

    // ── Prune cache entries older than 24h then save ───────────────────────
    const cutoff = Date.now() - COOLDOWN_MS;
    for (const [sym, ts] of Object.entries(cache)) {
      if (ts < cutoff) delete cache[sym];
    }
    await saveAlertedCache(cache);

    return res.status(200).json({
      success:      true,
      alerted,
      skipped,
      alertedCount: alerted.length,
      skippedCount: skipped.length,
      destination:  process.env.TELEGRAM_INFO_CHANNEL_ID
        ? 'Info channel'
        : 'Fallback — no TELEGRAM_INFO_CHANNEL_ID set (sent silently to each user)',
      checkedAt:    new Date().toISOString(),
    });

  } catch (err) {
    console.error('[ListingsAlert] Fatal:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};