/**
 * ─── Endpoint protection ──────────────────────────────────────────────────────
 *
 * CRON_SECRET
 *   Protects endpoints that send Telegram messages or change state.
 *   Pass it as  ?key=SECRET  or header  Authorization: Bearer SECRET
 *   (cron-job.org supports either).
 *
 * TELEGRAM_WEBHOOK_SECRET
 *   Telegram sends it back in the X-Telegram-Bot-Api-Secret-Token header on
 *   every webhook call (register it via /api/set-commands). Requests without
 *   it are rejected, so nobody can forge messages "from" the admin chat.
 *
 * If a secret is NOT configured the endpoint still works (so an existing
 * deployment doesn't break on upgrade) but logs a loud warning. Set both.
 */

const crypto = require('crypto');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function header(req, name) {
  const h = req.headers || {};
  return h[name] ?? h[name.toLowerCase()];
}

function presentedKey(req) {
  const auth = header(req, 'authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return (req.query && req.query.key) || header(req, 'x-cron-key') || null;
}

/** True if CRON_SECRET is configured and the request carries it. */
function hasValidCronKey(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const key = presentedKey(req);
  return !!key && safeEqual(key, secret);
}

function cronSecretConfigured() {
  return !!process.env.CRON_SECRET;
}

/**
 * For endpoints that cause side effects (alerts, state changes).
 * Returns true if the caller may proceed; otherwise sends 401 and returns false.
 */
function requireCronKey(req, res) {
  if (!cronSecretConfigured()) {
    console.warn(`[Auth] CRON_SECRET not set — ${req.url || 'endpoint'} is publicly callable. Set CRON_SECRET.`);
    return true;
  }
  if (hasValidCronKey(req)) return true;
  res.status(401).json({ success: false, error: 'Unauthorized — missing or invalid key' });
  return false;
}

/** For one-off admin endpoints: always requires CRON_SECRET to be set and supplied. */
function requireAdminKey(req, res) {
  if (!cronSecretConfigured()) {
    res.status(403).json({ success: false, error: 'Set CRON_SECRET in your environment, then call this with ?key=CRON_SECRET' });
    return false;
  }
  if (hasValidCronKey(req)) return true;
  res.status(401).json({ success: false, error: 'Unauthorized — missing or invalid key' });
  return false;
}

/**
 * Whether market-scan endpoints should send Telegram alerts on this call.
 * With CRON_SECRET set, only keyed (cron) calls alert — public/dashboard calls
 * just get data. Without it, behaviour is unchanged (every call may alert).
 */
function mayAlert(req) {
  return cronSecretConfigured() ? hasValidCronKey(req) : true;
}

function verifyTelegramWebhook(req) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Auth] TELEGRAM_WEBHOOK_SECRET not set — webhook accepts forged requests. Set it and re-run /api/set-commands.');
    return true;
  }
  const got = header(req, 'x-telegram-bot-api-secret-token');
  return !!got && safeEqual(got, secret);
}

function cors(res, methods = 'GET, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = {
  requireCronKey, requireAdminKey, hasValidCronKey, mayAlert,
  cronSecretConfigured, verifyTelegramWebhook, cors,
};
