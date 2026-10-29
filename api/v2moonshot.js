/**
 * ─── Auto Moonshot Alert Engine ──────────────────────────────────────────────
 * GET /api/v2moonshot?key=CRON_SECRET     (every 30 min via cron-job.org)
 *
 * Scans for high-scoring moonshot candidates and sends them to the admin chat.
 *
 * BUGFIX: this filtered on `coin.score >= 70` and printed `coin.reasons`, but
 * getMoonshots() returns `probability` and `greenSignals` — so it never sent a
 * single alert. It now uses the real fields.
 * Threshold: MOONSHOT_MIN_SCORE env var (default 70).
 * Dedup: 6h per coin, stored in Redis (the in-memory cache reset on cold starts).
 */

const { getMoonshots } = require('../src/services/listingsService');
const store = require('../src/lib/redis');
const tg = require('../src/lib/telegram');
const { cors, requireCronKey } = require('../src/lib/auth');

const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const CACHE_KEY   = 'cryptobot:moonshot-alerts';

function fmtPrice(p) {
  if (!p) return 'N/A';
  if (p < 0.001) return p.toFixed(8);
  if (p < 0.01)  return p.toFixed(6);
  return p.toFixed(4);
}

function buildMessage(coin) {
  const meta  = coin.meta;
  const price = meta?.currentPrice || coin.price;
  const p     = fmtPrice(price);
  const name  = tg.escapeMd(meta?.name || coin.base);

  const lines = [
    `🚨 *HIGH-SCORE MOONSHOT — ${name} (${coin.base})* 🚨`,
    ``,
    `📊 *Score:* ${coin.probability}/92 — ${coin.band}`,
    `_Heuristic score from 7 factors — not a probability, and not backtested._`,
    ``,
    `💰 *Current Price:* \`$${p}\``,
    `📈 *24H Change:*    +${Number(coin.change24h).toFixed(2)}%`,
    `💵 *24H Volume:*    $${(coin.volume / 1e6).toFixed(2)}M`,
    meta?.marketCap ? `🏦 *Market Cap:*    $${(meta.marketCap / 1e6).toFixed(1)}M` : '',
    coin.isTrending ? `🔥 *TRENDING on CoinGecko right now*` : '',
    ``,
    `🎯 *PROFIT TARGETS:*`,
    `  2X → \`$${fmtPrice(price * 2)}\` (+100%)`,
    `  3X → \`$${fmtPrice(price * 3)}\` (+200%)`,
    `  5X → \`$${fmtPrice(price * 5)}\` (+400%)`,
    ``,
    (coin.greenSignals || []).length ? `📋 *Why this coin:*` : '',
    ...(coin.greenSignals || []).slice(0, 5).map(r => `  ✅ ${r}`),
    (coin.redFlags || []).length ? `\n⚠️ *Watch out:*` : '',
    ...(coin.redFlags || []).slice(0, 3).map(r => `  • ${r}`),
    ``,
  ];

  if (meta?.contracts?.length > 0) {
    lines.push(`📋 *Contract Addresses:*`);
    meta.contracts.slice(0, 3).forEach(ct => {
      lines.push(`  *${tg.escapeMd(ct.chainLabel)}:*`);
      lines.push(`  \`${ct.address}\``);
    });
    lines.push(`⚠️ _Verify on CoinGecko before buying_`);
  } else if (meta?.isNativeAsset) {
    lines.push(`ℹ️ _Native asset — no contract address_`);
  } else {
    lines.push(`⚠️ _Verify contract on CoinGecko before buying_`);
  }
  if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);

  lines.push(
    ``,
    `── *HOW TO TRADE THIS* ──`,
    `1️⃣ Buy on exchange at \`$${p}\``,
    `2️⃣ Tell the bot you bought:`,
    `   \`buy ${coin.base} ${p} 2x\` ← alert at 2X`,
    `   \`buy ${coin.base} ${p} 5x\` ← alert at 5X`,
    `3️⃣ The bot monitors it and alerts you when to sell`,
    ``,
    `🔴 *RISK MANAGEMENT:*`,
    `  • ${coin.positionAdvice || 'Max 1-2% of your account on this trade'}`,
    `  • New coins are HIGH RISK — only money you can afford to lose`,
    `⏰ ${new Date().toUTCString()}`,
  );
  return lines.filter(Boolean).join('\n');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronKey(req, res)) return;

  try {
    const minScore  = Number(process.env.MOONSHOT_MIN_SCORE) || 70;
    const moonshots = await getMoonshots();
    const cache     = (await store.getJSON(CACHE_KEY, {}).catch(() => ({}))) || {};
    const nowMs     = Date.now();

    const qualified = moonshots.filter(c =>
      c.probability >= minScore && !(cache[c.base] && nowMs - cache[c.base] < COOLDOWN_MS)
    );

    for (const coin of qualified) {
      await tg.sendLong(process.env.TELEGRAM_CHAT_ID, buildMessage(coin));
      cache[coin.base] = Date.now();
      await tg.sleep(1000); // stay under Telegram rate limits
    }

    for (const [sym, ts] of Object.entries(cache)) if (nowMs - ts > COOLDOWN_MS) delete cache[sym];
    await store.setJSON(CACHE_KEY, cache).catch(e => console.error('[v2moonshot] cache save:', e.message));

    return res.status(200).json({
      success:   true,
      minScore,
      candidates: moonshots.map(c => ({ coin: c.base, score: c.probability })),
      alerted:   qualified.map(c => c.base),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[v2moonshot]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports.buildMessage = buildMessage;
