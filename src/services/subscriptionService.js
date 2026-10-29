/**
 * ─── Paid access (optional) ───────────────────────────────────────────────────
 * Off unless PAID_ACCESS_ENABLED=true. When on, approved users also need an
 * active subscription to use the bot and dashboard and to get position alerts.
 * The admin never pays. The admin can give free time with `grant`.
 *
 * Payments: Paystack and/or Flutterwave (whichever has a secret key set). A payment only counts after Paystack's verify API says
 * it succeeded for the right amount and currency (the webhook and the return
 * link are just triggers to check). The same goes for Flutterwave and its verify
 * API. Webhooks with a bad signature (Paystack) or hash (Flutterwave) are refused. Each payment reference is credited once.
 *
 * Env:
 *   PAID_ACCESS_ENABLED     true to require a subscription
 *   PAYSTACK_SECRET_KEY     sk_test_… / sk_live_…  (Paystack → Settings → API Keys)
 *   SUBSCRIPTION_PRICE      price per period in normal units, e.g. 5000 (default 5000)
 *   SUBSCRIPTION_CURRENCY   NGN (default), GHS, ZAR, KES, USD
 *   SUBSCRIPTION_DAYS       days per payment (default 30)
 *
 * Storage:
 *   cryptobot:sub:{chatId}        HASH paidUntil, email, plan, lastRef, remindedFor, expiredFor, grantedBy
 *   cryptobot:payref:{reference}  STRING chatId (set when the payment link is made, 7 days)
 *   cryptobot:paidref:{reference} STRING '1' — credited (SET NX → never twice)
 *   cryptobot:payments            LIST of JSON receipts (newest last)
 *   cryptobot:small:{chatId}      HASH usd, checkedAt — last Binance balance check (free small accounts)
 *
 * FREE FOR SMALL ACCOUNTS (v2.21): with paid access on, users whose Binance
 * Spot balance is at or below the admin's limit (default $100) use the bot for
 * free. Coins bought by the weekly savings plan don't count. The balance is
 * checked when they connect, open `balance` or `account`, when they hit the
 * "subscription ended" screen, and once a day for everyone; a check older than
 * 3 days no longer counts. Users above the limit are told once and asked to
 * subscribe. Admin: 💳 Subscriptions → 🆓 Free for small accounts, or
 * `subs free 100` / `subs free off`.
 */

const axios = require('axios');
const crypto = require('crypto');
const store = require('../lib/redis');
const users = require('./userService');

const PAYSTACK = 'https://api.paystack.co';
const subKey = (chatId) => `cryptobot:sub:${chatId}`;
const DAY = 86_400_000;

class PaymentError extends Error {}

// ─── Settings: set by the admin in the bot (💳 Subscriptions), env vars as defaults
// cryptobot:settings HASH paidAccess '1'|'0', price, currency, days
const SETTINGS = 'cryptobot:settings';
let cache = { at: 0, v: {} };

/** Refresh settings from storage (cached 15 s). Every entry point calls this first. */
async function loadSettings({ force = false } = {}) {
  if (!force && Date.now() - cache.at < 15_000) return cache.v;
  try { cache = { at: Date.now(), v: store.hashToObject(await store.cmd('HGETALL', SETTINGS)) }; } catch { /* keep last */ }
  return cache.v;
}
const _resetSettingsCache = () => { cache = { at: 0, v: {} }; };

function enabled() {
  if (cache.v.paidAccess === '1') return true;
  if (cache.v.paidAccess === '0') return false;
  return String(process.env.PAID_ACCESS_ENABLED || '').toLowerCase() === 'true';
}
function plan() {
  const v = cache.v;
  const num = (x) => (Number(x) > 0 ? Number(x) : null);
  const price = num(v.price) ?? num(process.env.SUBSCRIPTION_PRICE) ?? 5000;
  const days = Math.round(num(v.days) ?? num(process.env.SUBSCRIPTION_DAYS) ?? 30);
  const currency = String(v.currency || process.env.SUBSCRIPTION_CURRENCY || 'NGN').toUpperCase();
  return { price, currency, days, amountMinor: Math.round(price * 100) };
}

async function setPaidAccess(on) {
  await store.cmd('HSET', SETTINGS, 'paidAccess', on ? '1' : '0');
  await loadSettings({ force: true });
  return enabled();
}

// ─── Free for small accounts ──────────────────────────────────────────────────
const smallKey = (chatId) => `cryptobot:small:${chatId}`;
const SMALL_FRESH_MS = 3 * DAY;
const DEFAULT_FREE_LIMIT = 100;

/** The balance limit (USD) for free access, or 0 when off. */
function freeLimit() {
  const v = cache.v.freeLimit;
  if (v !== undefined && v !== '') return Math.max(0, Number(v) || 0);
  const env = process.env.FREE_ACCOUNT_LIMIT_USD;
  if (env !== undefined && env !== '') return Math.max(0, Number(env) || 0);
  return DEFAULT_FREE_LIMIT;
}

async function setFreeLimit(value) {
  const t = String(value ?? '').trim().toLowerCase();
  const n = ['off', 'no', '0', 'none'].includes(t) ? 0 : Number(t.replace(/[$,]/g, ''));
  if (!(n >= 0) || n > 100000) throw new PaymentError('Send a dollar amount, e.g. `subs free 100`, or `subs free off`.');
  await store.cmd('HSET', SETTINGS, 'freeLimit', String(n));
  await loadSettings({ force: true });
  return freeLimit();
}

/** Last balance check: { usd, checkedAt, fresh } or null. */
async function getSmall(chatId) {
  const h = store.hashToObject(await store.cmd('HGETALL', smallKey(chatId)));
  if (h.usd === undefined || !h.checkedAt) return null;
  return { usd: Number(h.usd), checkedAt: h.checkedAt, fresh: Date.now() - new Date(h.checkedAt).getTime() < SMALL_FRESH_MS };
}

/** True when this user qualifies for free access right now (based on the last check). */
async function isFreeSmall(chatId) {
  const limit = freeLimit();
  if (!(limit > 0)) return false;
  const sm = await getSmall(chatId);
  return !!(sm && sm.fresh && sm.usd <= limit);
}

/**
 * Save a balance reading (Spot total minus savings-plan coins).
 * Returns { usd, free, crossedOver } — crossedOver is true the first time a
 * user who was free goes above the limit (so they can be told once).
 */
async function recordBalance(chatId, totalUsd) {
  const savings = await require('./savingsPlan').liveHoldingsUsd(chatId).catch(() => 0);
  const counted = Math.max(0, Math.round((Number(totalUsd) - savings) * 100) / 100);
  const before = await getSmall(chatId);
  const limit = freeLimit();
  const free = limit > 0 && counted <= limit;
  // Told once: only when the previous check was free and this one isn't
  const crossedOver = !free && limit > 0 && !!(before && before.fresh && before.usd <= limit);
  await store.cmd('HSET', smallKey(chatId), 'usd', String(counted), 'checkedAt', new Date().toISOString());
  return { usd: counted, free, limit, crossedOver, savingsUsd: savings };
}

/**
 * Check a user's Binance balance now (if connected) and save it.
 * Skips users without Binance and checks newer than `minAgeMs`.
 */
async function refreshSmall(chatId, { minAgeMs = 10 * 60_000 } = {}) {
  await loadSettings();
  if (!(freeLimit() > 0)) return null;
  const sm = await getSmall(chatId);
  if (sm && Date.now() - new Date(sm.checkedAt).getTime() < minAgeMs) return { usd: sm.usd, free: sm.fresh && sm.usd <= freeLimit(), limit: freeLimit(), cached: true };
  const accounts = require('./tradingAccounts');
  const st = await accounts.getStatus(chatId);
  if (!st.connected || st.testnet) return null;
  const b = await accounts.getBalances(chatId);
  return recordBalance(chatId, b.totalUsd);
}

/** Once a day: re-check every connected user without a paid subscription. */
async function refreshAllSmall({ send = async () => {}, now = new Date() } = {}) {
  await loadSettings();
  if (!enabled() || !(freeLimit() > 0)) return { skipped: 'off' };
  const day = now.toISOString().slice(0, 10);
  const first = await store.cmd('SET', `cryptobot:small:ran:${day}`, '1', 'NX', 'EX', 3 * 86400).catch(() => 'OK');
  if (first !== 'OK') return { skipped: 'already ran today' };
  let checked = 0, free = 0, over = 0;
  for (const u of await users.getUsersByStatus('approved')) {
    if (users.isAdminId(u.chatId) || (await getSub(u.chatId)).active) continue;
    try {
      const r = await refreshSmall(u.chatId, { minAgeMs: 0 });
      if (!r) continue;
      checked++;
      if (r.free) free++; else over++;
      if (r.crossedOver) {
        await send(u.chatId, [
          `💳 *Your Binance balance is now ${fmtUsd(r.usd)}* — above the free limit of ${fmtUsd(r.limit)}.`,
          ``,
          `Free access is for small accounts. To keep using the bot (alerts, auto-trading, savings), subscribe — ${priceLabel()}:`,
          `\`subscribe you@example.com\``,
        ].join('\n')).catch(() => {});
      }
    } catch (err) { console.error('[Subs] small check', u.chatId, err.message); }
  }
  return { checked, free, over };
}

const fmtUsd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CURRENCIES = ['NGN', 'GHS', 'ZAR', 'KES', 'USD'];
async function setPlan({ price, days, currency } = {}) {
  const fields = [];
  if (price !== undefined) { const p = Number(String(price).replace(/[,₦$]/g, '')); if (!(p > 0)) throw new PaymentError('Price must be a positive number, e.g. 5000'); fields.push('price', String(p)); }
  if (days !== undefined) { const d = Math.round(Number(days)); if (!(d >= 1 && d <= 3660)) throw new PaymentError('Days must be between 1 and 3660'); fields.push('days', String(d)); }
  if (currency !== undefined) { const c = String(currency).toUpperCase(); if (!CURRENCIES.includes(c)) throw new PaymentError(`Currency must be one of ${CURRENCIES.join(', ')} (what Paystack supports)`); fields.push('currency', c); }
  if (fields.length) await store.cmd('HSET', SETTINGS, ...fields);
  await loadSettings({ force: true });
  return plan();
}

/** "31/12/2026", "31-12-2026", "2026-12-31", "31 Dec 2026" → end of that day, Lagos time. */
function parseDate(text) {
  const t = String(text || '').trim();
  let y, m, d;
  let r = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (r) [, y, m, d] = r.map(Number);
  else if ((r = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = r.map(Number);
  else if ((r = t.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/i))) {
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(r[2].toLowerCase());
    if (mi < 0) return null;
    d = Number(r[1]); m = mi + 1; y = Number(r[3]);
  } else return null;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2100)) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T23:59:59+01:00`;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null; // e.g. 31/02
  return new Date(iso);
}

/** Give access until an exact date (replaces whatever they had). */
async function setUntil(chatId, date, { grantedBy = null } = {}) {
  const dt = date instanceof Date ? date : parseDate(date);
  if (!dt || isNaN(dt)) throw new PaymentError('Send a date like 31/12/2026');
  if (dt.getTime() <= Date.now()) throw new PaymentError('That date is in the past');
  await store.cmd('HSET', subKey(chatId), 'paidUntil', dt.toISOString(), ...(grantedBy ? ['grantedBy', String(grantedBy)] : []));
  return dt.toISOString();
}

/** Give days to every approved user who has no active subscription (before switching paid access on). */
async function giveAllWithout(days, { grantedBy = null } = {}) {
  let n = 0;
  for (const u of await users.getUsersByStatus('approved')) {
    if (users.isAdminId(u.chatId)) continue;
    if ((await getSub(u.chatId)).active) continue;
    await extend(u.chatId, days, { grantedBy });
    n++;
  }
  return n;
}

async function countWithoutAccess() {
  let n = 0;
  for (const u of await users.getUsersByStatus('approved')) if (!users.isAdminId(u.chatId) && !(await getSub(u.chatId)).active) n++;
  return n;
}
const priceLabel = () => { const p = plan(); return `${p.currency} ${p.price.toLocaleString('en-US')} / ${p.days} days`; };

async function getSub(chatId) {
  const h = store.hashToObject(await store.cmd('HGETALL', subKey(chatId)));
  const until = h.paidUntil ? new Date(h.paidUntil).getTime() : 0;
  return {
    paidUntil: h.paidUntil || null,
    active: until > Date.now(),
    daysLeft: until > Date.now() ? Math.ceil((until - Date.now()) / DAY) : 0,
    email: h.email || null,
    lastRef: h.lastRef || null,
    remindedFor: h.remindedFor || null,
    expiredFor: h.expiredFor || null,
  };
}

/** Can this user use the bot right now? */
async function hasAccess(chatId) {
  await loadSettings();
  if (!enabled() || users.isAdminId(chatId)) return true;
  if ((await getSub(chatId)).active) return true;
  return isFreeSmall(chatId);
}

async function status(chatId) {
  await loadSettings();
  const s = await getSub(chatId);
  const small = await getSmall(chatId);
  const freeSmall = !s.active && (await isFreeSmall(chatId));
  return {
    required: enabled() && !users.isAdminId(chatId),
    isAdmin: users.isAdminId(chatId),
    active: !enabled() || users.isAdminId(chatId) || s.active || freeSmall,
    freeSmall,
    freeLimit: freeLimit(),
    smallUsd: small?.usd ?? null,
    smallCheckedAt: small?.checkedAt ?? null,
    paidUntil: s.paidUntil,
    daysLeft: s.daysLeft,
    email: s.email,
    price: priceLabel(),
    paymentsReady: providers().length > 0,
    providers: providers(),
  };
}

/** Approved users (and the admin) who currently have access — for alerts. */
async function getChatIdsWithAccess() {
  await loadSettings();
  const ids = await users.getAllActiveChatIds();
  if (!enabled()) return ids;
  const out = [];
  for (const id of ids) if (await hasAccess(id)) out.push(id);
  return out;
}

// ─── Paystack ─────────────────────────────────────────────────────────────────
function paystack(method, path, data) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new PaymentError('Payments are not set up yet (admin: add PAYSTACK_SECRET_KEY).');
  return axios.request({ method, url: `${PAYSTACK}${path}`, data, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    .then(r => r.data)
    .catch(err => { throw new PaymentError(`Paystack: ${err?.response?.data?.message || err.message}`); });
}

// ─── Flutterwave (v3 Standard checkout) ──────────────────────────────────────
const FLW = 'https://api.flutterwave.com/v3';
function flutterwave(method, path, data) {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new PaymentError('Flutterwave is not set up yet (admin: add FLW_SECRET_KEY).');
  return axios.request({ method, url: `${FLW}${path}`, data, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 15000 })
    .then(r => r.data)
    .catch(err => { throw new PaymentError(`Flutterwave: ${err?.response?.data?.message || err.message}`); });
}

const PROVIDER_NAMES = { flutterwave: 'Flutterwave', paystack: 'Paystack' };
/** Payment providers that are set up, in the order offered to users. */
function providers() {
  const out = [];
  if (process.env.FLW_SECRET_KEY) out.push('flutterwave');
  if (process.env.PAYSTACK_SECRET_KEY) out.push('paystack');
  return out;
}
const providerOf = (reference) => (String(reference).startsWith('cbf_') ? 'flutterwave' : 'paystack');

const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(String(e || '').trim());

/** Create a Paystack payment link for one period. */
async function startCheckout(chatId, { email, callbackUrl, provider = null }) {
  await loadSettings();
  const s = await getSub(chatId);
  email = String(email || s.email || '').trim().toLowerCase();
  if (!validEmail(email)) throw new PaymentError('Send your email for the receipt, e.g. `subscribe you@example.com`');
  const available = providers();
  if (!available.length) throw new PaymentError('Payments are not set up yet — ask the admin.');
  const via = provider && available.includes(provider) ? provider : available[0];
  const p = plan();
  const tail = `${chatId}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  let reference, url;

  if (via === 'flutterwave') {
    reference = `cbf_${tail}`;
    const r = await flutterwave('POST', '/payments', {
      tx_ref: reference, amount: p.price, currency: p.currency, redirect_url: callbackUrl,
      customer: { email }, meta: { chatId: String(chatId), days: p.days },
      customizations: { title: 'Crypto bot subscription', description: `${p.days} days of access` },
    });
    url = r?.data?.link;
    if (r?.status !== 'success' || !url) throw new PaymentError('Flutterwave did not return a payment link — try again.');
  } else {
    reference = `cb_${tail}`;
    const r = await paystack('POST', '/transaction/initialize', {
      email, amount: p.amountMinor, currency: p.currency, reference,
      callback_url: callbackUrl,
      metadata: { chatId: String(chatId), days: p.days, custom_fields: [{ display_name: 'Telegram ID', variable_name: 'chat_id', value: String(chatId) }] },
    });
    url = r?.data?.authorization_url;
    if (!r?.status || !url) throw new PaymentError('Paystack did not return a payment link — try again.');
  }
  await store.pipeline([
    ['SET', `cryptobot:payref:${reference}`, String(chatId), 'EX', 7 * 86400],
    ['HSET', subKey(chatId), 'email', email, 'lastRef', reference],
  ]);
  return { url, reference, provider: via, providerName: PROVIDER_NAMES[via], price: priceLabel() };
}

/** Ask the provider what happened to a payment → { ok, paidMajor, currency, paidAt, chatIdInMeta, status } */
async function verifyWithProvider(reference) {
  if (providerOf(reference) === 'flutterwave') {
    const r = await flutterwave('GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    const d = r?.data || {};
    return { ok: d.status === 'successful' && d.tx_ref === reference, status: d.status, paidMajor: Number(d.amount), currency: d.currency, paidAt: d.created_at, chatIdInMeta: d.meta?.chatId };
  }
  const r = await paystack('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
  const d = r?.data || {};
  return { ok: d.status === 'success', status: d.status, paidMajor: Number(d.amount) / 100, currency: d.currency, paidAt: d.paid_at, chatIdInMeta: d.metadata?.chatId };
}

/**
 * Ask Paystack whether a payment succeeded and, if so, extend the owner's
 * subscription exactly once. Safe to call any number of times.
 * @returns {{credited: boolean, already?: boolean, chatId?: string, paidUntil?: string, reason?: string}}
 */
async function confirmPayment(reference) {
  await loadSettings();
  reference = String(reference || '').trim();
  if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(reference)) return { credited: false, reason: 'bad reference' };
  const owner = await store.cmd('GET', `cryptobot:payref:${reference}`);
  if (!owner) return { credited: false, reason: 'unknown reference' };

  const v = await verifyWithProvider(reference);
  if (!v.ok) return { credited: false, chatId: owner, reason: `payment ${v.status || 'not found'}` };
  const p = plan();
  if (String(v.currency).toUpperCase() !== p.currency || !(v.paidMajor >= p.price - 1e-9)) {
    return { credited: false, chatId: owner, reason: `paid ${v.currency} ${v.paidMajor}, expected ${p.currency} ${p.price}` };
  }
  if (v.chatIdInMeta && String(v.chatIdInMeta) !== String(owner)) return { credited: false, reason: 'reference belongs to another user' };

  // Credit once, even if the webhook, the return link and `subscribe check` all arrive together
  if ((await store.cmd('SET', `cryptobot:paidref:${reference}`, '1', 'NX')) !== 'OK') {
    return { credited: false, already: true, chatId: owner, paidUntil: (await getSub(owner)).paidUntil };
  }
  const paidUntil = await extend(owner, p.days, { reference });
  await store.cmd('RPUSH', 'cryptobot:payments', JSON.stringify({
    reference, provider: providerOf(reference), chatId: owner, amount: v.paidMajor, currency: v.currency, days: p.days,
    paidAt: v.paidAt || new Date().toISOString(), paidUntil,
  }));
  return { credited: true, chatId: owner, paidUntil };
}

/** Add days to a subscription (from now, or from the current end if still active). */
async function extend(chatId, days, { reference = null, grantedBy = null } = {}) {
  const s = await getSub(chatId);
  const from = s.active ? new Date(s.paidUntil).getTime() : Date.now();
  const paidUntil = new Date(from + days * DAY).toISOString();
  await store.cmd('HSET', subKey(chatId), 'paidUntil', paidUntil, ...(reference ? ['lastRef', reference] : []), ...(grantedBy ? ['grantedBy', String(grantedBy)] : []));
  return paidUntil;
}

async function revoke(chatId) {
  await store.cmd('HSET', subKey(chatId), 'paidUntil', new Date(Date.now() - 1000).toISOString());
}

/**
 * Paystack webhook. Requests without a valid x-paystack-signature (HMAC-SHA512
 * of the body with PAYSTACK_SECRET_KEY) are REJECTED before anything else, so
 * nobody can make the bot call Paystack by posting fake events. A genuine
 * payment is then still only credited after Paystack's verify API confirms it.
 * (If a real webhook were ever refused, the payer is still credited by the /paid
 * return link and by `subscribe check`, which ask Paystack directly.)
 */
function paystackSignatureOk(rawBody, signature) {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  if (!key || !signature) return false;
  const body = typeof rawBody === 'string' || Buffer.isBuffer(rawBody) ? rawBody : JSON.stringify(rawBody || {});
  const expected = crypto.createHmac('sha512', key).update(body).digest('hex');
  const got = String(signature);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

async function handleWebhook(rawBody, signature) {
  if (!paystackSignatureOk(rawBody, signature)) return { ignored: true, rejected: true, reason: 'bad or missing signature' };
  let event;
  try { event = typeof rawBody === 'string' || Buffer.isBuffer(rawBody) ? JSON.parse(String(rawBody)) : rawBody; } catch { event = null; }
  if (!event || event.event !== 'charge.success' || !event.data?.reference) return { ignored: true };
  return confirmPayment(event.data.reference);
}

/**
 * Flutterwave webhook. If FLW_SECRET_HASH is set (Flutterwave dashboard →
 * Webhooks → Secret hash), the `verif-hash` header must match. Either way,
 * nothing is credited unless Flutterwave's verify API confirms the payment.
 */
async function handleFlutterwaveWebhook(body, verifHash) {
  const expected = process.env.FLW_SECRET_HASH;
  if (expected) {
    const ok = !!verifHash && verifHash.length === expected.length && crypto.timingSafeEqual(Buffer.from(verifHash), Buffer.from(expected));
    if (!ok) return { ignored: true, reason: 'bad verif-hash' };
  }
  let event = body;
  if (typeof body === 'string') { try { event = JSON.parse(body); } catch { event = null; } }
  const ref = event?.data?.tx_ref || event?.txRef;
  if (!ref || !String(ref).startsWith('cbf_')) return { ignored: true };
  return confirmPayment(ref);
}

/**
 * Reminders, run from the monitor: 3 days before the end, and once when it ends.
 * @param send (chatId, text) => Promise
 */
async function sendReminders(send) {
  await loadSettings();
  if (!enabled()) return { reminded: 0, expired: 0 };
  let reminded = 0, expired = 0;
  for (const u of await users.getUsersByStatus('approved')) {
    const s = await getSub(u.chatId);
    if (!s.paidUntil) continue;
    const left = new Date(s.paidUntil).getTime() - Date.now();
    if (left > 0 && left <= 3 * DAY && s.remindedFor !== s.paidUntil) {
      await send(u.chatId, `⏳ *Your subscription ends in ${Math.ceil(left / DAY)} day${left > DAY ? 's' : ''}* (${new Date(s.paidUntil).toUTCString()}).\n\nRenew with \`subscribe\` — ${priceLabel()}. Time is added to what you have left.`);
      await store.cmd('HSET', subKey(u.chatId), 'remindedFor', s.paidUntil);
      reminded++;
    } else if (left <= 0 && s.expiredFor !== s.paidUntil) {
      await send(u.chatId, `🔒 *Your subscription has ended.* Position alerts are paused.\n\nRenew any time with \`subscribe\` — ${priceLabel()}.\n_Any stop orders already on your exchange stay there._`);
      await store.cmd('HSET', subKey(u.chatId), 'expiredFor', s.paidUntil);
      expired++;
    }
  }
  return { reminded, expired };
}

async function listSubscribers() {
  const out = [];
  for (const u of await users.getUsersByStatus('approved')) out.push({ user: u, sub: await getSub(u.chatId) });
  return out.sort((a, b) => String(b.sub.paidUntil || '').localeCompare(String(a.sub.paidUntil || '')));
}

module.exports = {
  PaymentError, enabled, plan, priceLabel, freeLimit, setFreeLimit, getSmall, isFreeSmall, recordBalance, refreshSmall, refreshAllSmall, providers, PROVIDER_NAMES, handleFlutterwaveWebhook, loadSettings, setPaidAccess, setPlan, parseDate, setUntil, giveAllWithout, countWithoutAccess, CURRENCIES, _resetSettingsCache, getSub, hasAccess, status, getChatIdsWithAccess,
  startCheckout, confirmPayment, extend, revoke, handleWebhook, paystackSignatureOk, sendReminders, listSubscribers, validEmail,
};

/** Tell the user (and the admin) about a credited payment. */
async function notifyCredited(result) {
  if (!result?.credited) return;
  const tg = require('../lib/telegram');
  const until = new Date(result.paidUntil).toUTCString();
  await tg.send(result.chatId, `✅ *Payment received — thank you!*\n\nYour access is active until *${until}*.\nTap *📋 MENU* to carry on.`).catch(() => {});
  const admin = process.env.TELEGRAM_CHAT_ID;
  if (admin && String(admin) !== String(result.chatId)) {
    const u = await users.getUser(result.chatId).catch(() => null);
    await tg.send(admin, `💰 ${tg.escapeMd(users.formatName(u || { chatId: result.chatId }))} paid ${priceLabel()} — active until ${until}.`).catch(() => {});
  }
}
module.exports.notifyCredited = notifyCredited;
