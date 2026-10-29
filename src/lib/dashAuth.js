/**
 * ─── Dashboard login links ────────────────────────────────────────────────────
 * Users send /dashboard to the bot and get a personal link:
 *   https://<app>/dashboard#t=<token>
 *
 * The token is signed (HMAC-SHA256) with a key derived from the bot token, so
 * no extra secret is needed, and nobody can forge one for another chat id.
 * It sits in the URL #fragment, which browsers never send to the server or
 * put in Referer headers. The dashboard stores it and sends it as a Bearer
 * header.
 *
 * Revocation: each user has a version number in Redis. `/dashboard logout`
 * bumps it, which invalidates every link issued before.
 */

const crypto = require('crypto');
const store = require('./redis');

const DEFAULT_DAYS = 30;

function signingKey() {
  const base = process.env.DASHBOARD_SECRET || process.env.TELEGRAM_BOT_TOKEN;
  if (!base) throw new Error('TELEGRAM_BOT_TOKEN (or DASHBOARD_SECRET) is required for dashboard links');
  return crypto.createHmac('sha256', 'cryptobot-dashboard-v1').update(base).digest();
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sign = (payload) => b64url(crypto.createHmac('sha256', signingKey()).update(payload).digest());
const versionKey = (chatId) => `cryptobot:dashver:${chatId}`;

async function currentVersion(chatId) {
  const v = await store.cmd('GET', versionKey(chatId));
  return v ? Number(v) : 0;
}

/** Create a login token for this chat id. */
async function issueToken(chatId, days = DEFAULT_DAYS) {
  const payload = b64url(JSON.stringify({
    c: String(chatId),
    e: Date.now() + days * 86_400_000,
    v: await currentVersion(chatId),
  }));
  return `${payload}.${sign(payload)}`;
}

/** Validate a token. Returns the chat id, or null if invalid/expired/revoked. */
async function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(fromB64url(payload).toString('utf8')); } catch { return null; }
  if (!data.c || !data.e || Date.now() > data.e) return null;
  if ((await currentVersion(data.c)) !== Number(data.v || 0)) return null;
  return String(data.c);
}

/** Invalidate every link issued so far for this chat id. */
async function revokeAll(chatId) {
  const v = (await currentVersion(chatId)) + 1;
  await store.cmd('SET', versionKey(chatId), String(v));
  return v;
}

function tokenFromRequest(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/** Public base URL of the site, for links sent in Telegram. */
function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'https://crptotradingbot.vercel.app';
}

async function dashboardLink(chatId) {
  return `${baseUrl()}/dashboard#t=${await issueToken(chatId)}`;
}

module.exports = { issueToken, verifyToken, revokeAll, tokenFromRequest, dashboardLink, baseUrl };
