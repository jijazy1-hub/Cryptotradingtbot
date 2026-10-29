/**
 * ─── One-time bot setup ──────────────────────────────────────────────────────
 * GET /api/set-commands?key=CRON_SECRET
 *   → https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET
 *
 * 1. Registers the "/" command menu with Telegram.
 * 2. (Re)registers the webhook at https://<this-host>/api/telegram-webhook,
 *    including TELEGRAM_WEBHOOK_SECRET so Telegram signs every update.
 *    Run it again whenever you change TELEGRAM_WEBHOOK_SECRET or your domain.
 *    Override the URL with PUBLIC_BASE_URL if needed.
 *
 * Requires CRON_SECRET (it changes bot configuration).
 */

const tg = require('../src/lib/telegram');
const { requireAdminKey } = require('../src/lib/auth');

const COMMANDS = [
  { command: 'menu',        description: '📋 Open the main menu' },
  { command: 'dashboard',   description: '🖥 Your personal web dashboard (live P&L)' },
  { command: 'scan',        description: '🔍 Small caps with strong momentum (high risk)' },
  { command: 'moonshots',   description: '🌕 Small caps with strong momentum' },
  { command: 'newlistings', description: '🚀 Hot new coins with contract addresses' },
  { command: 'buy',         description: '💰 Track a buy — e.g. /buy SOL 92.50 2x' },
  { command: 'sell',        description: '💸 Stop tracking a position — e.g. /sell SOL' },
  { command: 'sold',        description: '🧾 Record a sale — e.g. /sold SOL 92.50 110' },
  { command: 'positions',   description: '📊 View your open positions' },
  { command: 'setstop',     description: '🛡 Change your stop — e.g. /setstop SOL 88.5' },
  { command: 'check',       description: '🔎 Instant advice on a position — e.g. /check SOL' },
  { command: 'profit',      description: '📈 Your trading stats' },
  { command: 'autotrade',   description: '🤖 Automated exits on Binance (optional)' },
  { command: 'account',     description: '💳 Your subscription' },
  { command: 'subscribe',   description: '💳 Subscribe / renew' },
  { command: 'help',        description: '📖 Show all commands' },
];

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
  return host ? `https://${host}` : null;
}

module.exports = async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  if (!tg.isConfigured()) return res.status(500).json({ success: false, error: 'TELEGRAM_BOT_TOKEN not set' });

  const out = { success: true, commands: null, webhook: null, warnings: [] };

  try {
    await tg.call('setMyCommands', { commands: COMMANDS });
    out.commands = COMMANDS.map(c => `/${c.command}`);
  } catch (err) {
    out.success = false;
    out.commands = { error: err.message };
  }

  const base = baseUrl(req);
  if (!base) {
    out.warnings.push('Could not work out this site\'s URL — set PUBLIC_BASE_URL to register the webhook.');
  } else {
    const params = {
      url: `${base}/api/telegram-webhook`,
      allowed_updates: ['message', 'callback_query'],
    };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET)) {
        out.warnings.push('TELEGRAM_WEBHOOK_SECRET may only contain letters, numbers, _ and - (max 256).');
      } else {
        params.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
      }
    } else {
      out.warnings.push('TELEGRAM_WEBHOOK_SECRET is not set — the webhook will accept forged requests. Set it and run this again.');
    }
    try {
      await tg.call('setWebhook', params);
      out.webhook = { url: params.url, secretTokenRegistered: !!params.secret_token };
    } catch (err) {
      out.success = false;
      out.webhook = { error: err.message };
    }
  }

  return res.status(out.success ? 200 : 500).json(out);
};
