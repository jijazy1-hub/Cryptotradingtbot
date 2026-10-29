/**
 * ─── User app API (one function, many actions) ───────────────────────────────
 * /api/app?action=…   — Authorization: Bearer <dashboard token from /dashboard>
 *
 * One file on purpose: Vercel's Hobby plan allows 12 functions, so new
 * user-facing features (dashboard now; later payments and trading settings)
 * are added as actions here instead of new files.
 *
 *   GET  me          who am I
 *   GET  portfolio   open positions with live prices + totals
 *   GET  history     closed trades + stats
 *   POST add         { symbol, buyPrice, quantity?, target?, stop? }
 *   POST setstop     { positionId, price }
 *   POST sold        { positionId, sellPrice, quantity? }
 *   POST remove      { positionId }
 *   GET  trading             automated-exit status (never returns keys)
 *   GET  balance             the user's Binance Spot wallet, valued in USD
 *   POST trading-connect     { apiKey, apiSecret, live? }
 *   POST trading-mode        { enabled, confirm? }   confirm phrase needed for live
 *   POST trading-disconnect
 *   GET  practice            practice account (play money, real prices)
 *   POST practice-buy        { symbol, amount, stop?, target? }
 *   POST practice-sell       { positionId }
 *   POST practice-reset
 *   GET  autobuy             auto-buy status (strategy, test verdict, forward test, my settings)
 *   POST autobuy-set         { practice?: bool, live?: bool }
 *   GET  subscription        paid-access status
 *   POST subscribe           { email } → Paystack payment link
 *
 * Public (no login; the payment providers call these):
 *   POST paystack-webhook    (/paystack-webhook) refused without a valid x-paystack-signature; then verified with Paystack's API
 *   POST flutterwave-webhook (/flutterwave-webhook) payment events → verified with Flutterwave's API
 *   GET  paystack-callback   (/paid) where Paystack sends the payer back → Telegram
 */

const { verifyToken, tokenFromRequest } = require('../src/lib/dashAuth');
const users = require('../src/services/userService');
const portfolio = require('../src/services/portfolioService');
const subs = require('../src/services/subscriptionService');
const practice = require('../src/services/practiceService');
const autoBuyer = require('../src/services/autoBuyer');
const { baseUrl } = require('../src/lib/dashAuth');

const ACTIONS = {
  me:        { method: 'GET',  run: async (chatId) => {
    const user = await users.getUser(chatId);
    return {
      chatId,
      name: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Trader' : 'Admin',
      username: user?.username || null,
      isAdmin: users.isAdminId(chatId),
    };
  } },
  portfolio: { method: 'GET',  run: (chatId) => portfolio.getPortfolio(chatId) },
  history:   { method: 'GET',  run: (chatId) => portfolio.getHistory(chatId) },
  add:       { method: 'POST', run: (chatId, body) => portfolio.createPosition(chatId, body) },
  setstop:   { method: 'POST', run: (chatId, body) => portfolio.setStop(chatId, body) },
  sold:      { method: 'POST', run: (chatId, body) => portfolio.recordSale(chatId, body) },
  remove:    { method: 'POST', run: (chatId, body) => portfolio.removePosition(chatId, body) },
  trading:              { method: 'GET',  run: (chatId) => portfolio.tradingStatus(chatId) },
  balance:              { method: 'GET',  run: (chatId) => portfolio.tradingBalance(chatId) },
  'trading-connect':    { method: 'POST', run: (chatId, body) => portfolio.tradingConnect(chatId, body) },
  'trading-mode':       { method: 'POST', run: (chatId, body) => portfolio.tradingMode(chatId, body) },
  'trading-disconnect': { method: 'POST', run: (chatId) => portfolio.tradingDisconnect(chatId) },
  practice:             { method: 'GET',  run: (chatId) => practice.summary(chatId) },
  'practice-buy':       { method: 'POST', run: (chatId, body) => practice.buy(chatId, body) },
  'practice-sell':      { method: 'POST', run: (chatId, body) => practice.sellNow(chatId, { positionId: body.positionId }) },
  'practice-reset':     { method: 'POST', run: (chatId) => practice.reset(chatId) },
  autobuy:              { method: 'GET',  run: (chatId) => autoBuyer.userStatus(chatId) },
  'autobuy-set':        { method: 'POST', run: async (chatId, body) => {
    if (body.practice !== undefined) await autoBuyer.setPractice(chatId, !!body.practice);
    if (body.live !== undefined) await autoBuyer.setLive(chatId, !!body.live);
    return autoBuyer.userStatus(chatId);
  } },
  subscription:         { method: 'GET',  run: (chatId) => subs.status(chatId) },
  subscribe:            { method: 'POST', run: (chatId, body) => subs.startCheckout(chatId, { email: body.email, provider: body.provider, callbackUrl: `${baseUrl()}/paid` }) },
};

// Usable while a subscription has ended (so the user can see status and pay)
const ALWAYS_ALLOWED = new Set(['me', 'subscription', 'subscribe', 'trading', 'trading-mode', 'trading-disconnect']);

// ─── Public Paystack endpoints ───────────────────────────────────────────────
const PUBLIC = {
  'paystack-webhook': async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    try {
      // Check the signature on the exact bytes Paystack sent when we can get them
      const raw = await readRawBody(req);
      const r = await subs.handleWebhook(raw ?? req.body, req.headers?.['x-paystack-signature']);
      if (r.rejected) {
        console.warn('[paystack-webhook] refused: bad or missing signature');
        return res.status(401).json({ ok: false });
      }
      if (r.credited) await subs.notifyCredited(r);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[paystack-webhook]', err.message);
      return res.status(500).json({ ok: false }); // Paystack retries later
    }
  },
  'flutterwave-webhook': async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    try {
      const r = await subs.handleFlutterwaveWebhook(req.body, req.headers?.['verif-hash']);
      if (r.credited) await subs.notifyCredited(r);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[flutterwave-webhook]', err.message);
      return res.status(500).json({ ok: false }); // Flutterwave retries later
    }
  },
  'paystack-callback': async (req, res) => {
    // Shared return link for both providers: Paystack sends ?reference=, Flutterwave ?tx_ref=
    const reference = req.query?.reference || req.query?.trxref || req.query?.tx_ref;
    let start = 'paid';
    try {
      const r = await subs.confirmPayment(reference);
      if (r.credited) await subs.notifyCredited(r);
      else if (!r.already) start = 'payfailed';
    } catch (err) {
      console.error('[paystack-callback]', err.message);
      start = 'payfailed';
    }
    res.setHeader('Location', `https://t.me/${process.env.BOT_USERNAME || 'JijazyBot'}?start=${start}`);
    return res.status(302).end();
  },
};

/** The unparsed request body, if the platform hasn't consumed it yet (else null). */
function readRawBody(req, timeoutMs = 1500) {
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (!req || typeof req.on !== 'function' || req.readableEnded || req.readable === false) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    const done = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done(chunks.length ? Buffer.concat(chunks) : null), timeoutMs);
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => done(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', () => done(null));
  });
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Same-origin dashboard only: no CORS headers on purpose.
  await subs.loadSettings().catch(() => {});
  const name = String(req.query?.action || '');
  if (PUBLIC[name]) return PUBLIC[name](req, res);
  const action = ACTIONS[name];
  if (!action) return res.status(404).json({ success: false, error: 'Unknown action' });
  if (req.method !== action.method) return res.status(405).json({ success: false, error: `Use ${action.method}` });

  const chatId = await verifyToken(tokenFromRequest(req)).catch(() => null);
  if (!chatId) return res.status(401).json({ success: false, error: 'Login expired — send /dashboard to the bot for a new link' });
  if (await users.isBlocked(chatId)) return res.status(403).json({ success: false, error: 'Access revoked' });
  if (!(await users.isApproved(chatId))) return res.status(403).json({ success: false, error: 'Your access is pending approval' });
  if (!ALWAYS_ALLOWED.has(name) && !(await subs.hasAccess(chatId))) {
    return res.status(402).json({ success: false, code: 'subscription', error: `Your subscription has ended — renew to continue (${subs.priceLabel()})` });
  }

  try {
    const data = await action.run(chatId, parseBody(req));
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof portfolio.UserError || err instanceof subs.PaymentError || err instanceof practice.PracticeError || err instanceof autoBuyer.AutoBuyError) return res.status(400).json({ success: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
    console.error(`[app:${name}]`, err.stack || err.message);
    return res.status(500).json({ success: false, error: 'Something went wrong — try again' });
  }
};
