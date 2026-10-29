/**
 * ─── Weekly savings plan ("add money weekly") ─────────────────────────────────
 * The user tops up USDT on Binance each week; once a week (their chosen day,
 * 9am Lagos time) the bot buys a fixed dollar amount of BTC / ETH for them.
 * The bot NEVER sells savings — they are long-term holdings, not trades, so
 * they get no stop orders and never count as positions.
 *
 *  💰 REAL     — buys on the user's own Binance account (auto-trading must be on)
 *  🎮 PRACTICE — the same plan with play money (new play money each week,
 *               separate from the $10,000 practice account), at live prices
 *
 * The day before a real buy, users without enough USDT in Spot get a reminder.
 * If the USDT isn't there at buy time, the bot says so once and keeps trying
 * every 30 minutes; after 6 days that week is skipped.
 *
 * Storage:
 *   cryptobot:save:{chatId}          HASH amount, coins, day (0=Sun…6=Sat, Lagos), mode,
 *                                      active, nextDue, createdAt, waitDue, remindDue
 *   cryptobot:save:users             SET of chatIds with a plan
 *   cryptobot:save:log:{chatId}      LIST of JSON buys {at, mode, coin, usd, qty, price}
 *   cryptobot:save:did:{chatId}:{due} '1' — that week's buy was placed (never twice)
 */

const store = require('../lib/redis');
const { fetchPrice } = require('../lib/market');
const cfg = require('../config/autobuy');

const K = {
  plan: (id) => `cryptobot:save:${id}`,
  users: 'cryptobot:save:users',
  log: (id) => `cryptobot:save:log:${id}`,
  did: (id, due) => `cryptobot:save:did:${id}:${due}`,
  lock: (id) => `cryptobot:lock:save:${id}`,
};

const COINS = ['BTC', 'ETH', 'BNB', 'SOL'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const BUY_HOUR_UTC = 8;           // 9am Lagos
const WEEK = 7 * 86_400_000;
const GIVE_UP_AFTER = 6 * 86_400_000;
const MIN = () => cfg.LIMITS.minOrderUsd;
const MAX = 10_000;
const FEE = 0.001, SLIP = 0.0005; // same costs as practice mode

class SavingsError extends Error {}

const r2 = (x) => Math.round(x * 100) / 100;
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lagosDay = (t = new Date()) => new Date(t.getTime() + 3_600_000).getUTCDay();

/** The next buy time on `day` (0–6) at 9am Lagos, at or after `from`. */
function nextOccurrence(day, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), BUY_HOUR_UTC));
  for (let k = 0; k < 8; k++) {
    const t = new Date(d.getTime() + k * 86_400_000);
    if (t.getUTCDay() === day && t.getTime() >= from.getTime()) return t;
  }
  return new Date(d.getTime() + WEEK);
}

function parseDay(text) {
  const t = String(text || '').trim().toLowerCase();
  const i = DAYS.findIndex(d => d.toLowerCase().startsWith(t.slice(0, 3)) && t.length >= 2);
  return i;
}

/** Split the weekly amount across the coins; every part must meet Binance's minimum. */
function parts(amount, coins) {
  const n = coins.length;
  const each = Math.floor((amount / n) * 100) / 100;
  const out = coins.map((coin, i) => ({ coin, usd: i === n - 1 ? r2(amount - each * (n - 1)) : each }));
  if (out.some(p => p.usd < MIN())) {
    throw new SavingsError(`${usd(amount)} split across ${coins.join(' + ')} is less than $${MIN()} each (Binance's minimum order). Choose one coin, e.g. \`save ${amount} btc\`, or save at least ${usd(MIN() * n)}.`);
  }
  return out;
}

function defaultCoins(amount) {
  return amount >= MIN() * 2 ? ['BTC', 'ETH'] : ['BTC'];
}

async function getPlan(chatId) {
  const h = store.hashToObject(await store.cmd('HGETALL', K.plan(chatId)));
  if (!h.amount) return null;
  const coins = String(h.coins || 'BTC').split(',').filter(Boolean);
  return {
    amount: Number(h.amount), coins, day: Number(h.day), mode: h.mode === 'live' ? 'live' : 'practice',
    active: h.active === '1', nextDue: h.nextDue || null, createdAt: h.createdAt || null,
    waitDue: h.waitDue || null, remindDue: h.remindDue || null,
    parts: (() => { try { return parts(Number(h.amount), coins); } catch { return coins.map(coin => ({ coin, usd: r2(Number(h.amount) / coins.length) })); } })(),
  };
}

/**
 * Create or change a plan. Only the fields given are changed.
 * A new plan starts active, on today's weekday unless `day` is given.
 */
async function setPlan(chatId, { amount, coins, day, mode } = {}, now = new Date()) {
  const cur = await getPlan(chatId);
  const amt = amount !== undefined ? Number(String(amount).replace(/[$,]/g, '')) : cur?.amount;
  if (!(amt >= MIN()) || amt > MAX) throw new SavingsError(`Choose a weekly amount from $${MIN()} to $${MAX.toLocaleString('en-US')}, e.g. \`save 10\`.`);
  let list;
  if (coins !== undefined) list = [...new Set(coins.map(c => String(c).toUpperCase().replace(/USDT$/, '')))];
  else if (!cur) list = defaultCoins(amt);
  else {
    list = cur.coins;
    // amount lowered below what the coins need: fall back to BTC only
    if (amount !== undefined) { try { parts(amt, list); } catch { list = defaultCoins(amt); } }
  }
  const bad = list.filter(c => !COINS.includes(c));
  if (bad.length) throw new SavingsError(`The savings plan buys ${COINS.join(', ')} — not ${bad.join(', ')}.`);
  if (!list.length) list = ['BTC'];
  parts(amt, list); // throws if too small per coin
  const d = day !== undefined ? Number(day) : cur ? cur.day : lagosDay(now);
  if (!(d >= 0 && d <= 6)) throw new SavingsError('Choose a day: `save day monday`');
  const m = mode || cur?.mode || 'practice';
  const fields = ['amount', String(amt), 'coins', list.join(','), 'day', String(d), 'mode', m];
  if (!cur) fields.push('active', '1', 'createdAt', now.toISOString(), 'nextDue', nextOccurrence(d, now).toISOString());
  else if (day !== undefined && Number(day) !== cur.day) fields.push('nextDue', nextOccurrence(d, now).toISOString(), 'waitDue', '', 'remindDue', '');
  if (cur && mode && mode !== cur.mode) fields.push('waitDue', '', 'remindDue', '');
  await store.cmd('HSET', K.plan(chatId), ...fields);
  await store.cmd('SADD', K.users, String(chatId));
  return getPlan(chatId);
}

async function setActive(chatId, on, now = new Date()) {
  const p = await getPlan(chatId);
  if (!p) throw new SavingsError('You have no savings plan yet. Start one with `save 10`.');
  const fields = ['active', on ? '1' : '0'];
  // Resuming after a long pause: start from the next buy day, not weeks in the past
  if (on && (!p.nextDue || new Date(p.nextDue).getTime() < now.getTime() - GIVE_UP_AFTER)) fields.push('nextDue', nextOccurrence(p.day, now).toISOString(), 'waitDue', '');
  await store.cmd('HSET', K.plan(chatId), ...fields);
  return getPlan(chatId);
}

/** Delete the plan. The record of past buys is kept (it's history). */
async function stop(chatId) {
  await store.cmd('DEL', K.plan(chatId));
  await store.cmd('SREM', K.users, String(chatId));
}

async function getLog(chatId) {
  const rows = (await store.cmd('LRANGE', K.log(chatId), 0, -1)) || [];
  return rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

/** Totals for one mode: put in, coins held, value now. */
async function summary(chatId, { mode = null, prices = null } = {}) {
  const plan = await getPlan(chatId);
  const m = mode || plan?.mode || 'practice';
  const buys = (await getLog(chatId)).filter(b => b.mode === m);
  const held = {};
  let invested = 0;
  for (const b of buys) { held[b.coin] = (held[b.coin] || 0) + Number(b.qty || 0); invested += Number(b.usd || 0); }
  let value = 0, priced = true;
  const holdings = [];
  for (const [coin, qty] of Object.entries(held)) {
    let px = prices?.[coin];
    if (px === undefined) px = await fetchPrice(`${coin}USDT`, { exchange: 'binance' }).catch(() => null);
    if (!px) priced = false;
    const v = px ? qty * px : null;
    if (v) value += v;
    holdings.push({ coin, qty, price: px, usd: v === null ? null : r2(v) });
  }
  return {
    plan, mode: m, buys: buys.length, invested: r2(invested), value: priced ? r2(value) : null,
    pnl: priced ? r2(value - invested) : null, pnlPct: priced && invested > 0 ? r2((value / invested - 1) * 100) : null,
    holdings, lastBuy: buys.at(-1) || null,
  };
}

/** Dollar value of the coins a REAL plan bought — excluded from the free-access size check. */
async function liveHoldingsUsd(chatId) {
  const s = await summary(chatId, { mode: 'live' }).catch(() => null);
  return s?.value || 0;
}

/** USDT that auto-buy should leave alone because a real savings buy is due within a day. */
async function reservedUsd(chatId, now = new Date()) {
  const p = await getPlan(chatId);
  if (!p || !p.active || p.mode !== 'live' || !p.nextDue) return 0;
  return new Date(p.nextDue).getTime() - now.getTime() <= 86_400_000 ? p.amount : 0;
}

// ─── Buying ──────────────────────────────────────────────────────────────────
async function buyPractice(chatId, plan, now) {
  const bought = [];
  for (const part of plan.parts) {
    const price = await fetchPrice(`${part.coin}USDT`, { exchange: 'binance' });
    if (!price) throw new SavingsError(`couldn't get the ${part.coin} price`);
    const fill = price * (1 + SLIP);
    const qty = (part.usd * (1 - FEE)) / fill;
    const row = { at: now.toISOString(), mode: 'practice', coin: part.coin, usd: part.usd, qty, price: fill };
    await store.cmd('RPUSH', K.log(chatId), JSON.stringify(row));
    bought.push(row);
  }
  return { bought, failed: [] };
}

async function buyLive(chatId, plan, client, now) {
  const { floorToStep } = require('../lib/binanceTrade');
  const bought = [], failed = [];
  for (const part of plan.parts) {
    const symbol = `${part.coin}USDT`;
    try {
      const rules = await client.symbolRules(symbol);
      const o = await client.marketBuy(symbol, part.usd.toFixed(2), `cb-sv-${Date.now().toString(36)}-${part.coin.toLowerCase()}`);
      let qty = Number(o.executedQty) || 0;
      let price = qty > 0 ? Number(o.cummulativeQuoteQty) / qty : null;
      if (o.dryRun) { // test mode: no real order — estimate from the price
        price = await fetchPrice(symbol, { exchange: 'binance' });
        qty = part.usd / price;
      } else {
        const feeInCoin = (o.fills || []).filter(f => f.commissionAsset === rules.baseAsset).reduce((t, f) => t + Number(f.commission), 0);
        qty = floorToStep(qty - feeInCoin, rules.stepSize);
      }
      if (!(qty > 0)) throw new Error('order not filled');
      const row = { at: now.toISOString(), mode: 'live', coin: part.coin, usd: part.usd, qty, price, ...(o.dryRun ? { dryRun: true } : {}) };
      await store.cmd('RPUSH', K.log(chatId), JSON.stringify(row));
      bought.push(row);
    } catch (err) {
      failed.push({ coin: part.coin, usd: part.usd, error: err.message });
    }
  }
  return { bought, failed };
}

const fmtQty = (q) => String(+Number(q).toPrecision(6));
const fmtPx = (p) => (p >= 1000 ? `$${Math.round(p).toLocaleString('en-US')}` : `$${Number(p).toPrecision(5)}`);
const when = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const tag = (mode) => (mode === 'live' ? '💰 REAL' : '🎮 PRACTICE');

function boughtMessage(plan, result, s) {
  const lines = [
    `🐷 ${tag(plan.mode)} · *Weekly savings*`,
    ...result.bought.map(b => `✅ Bought ${usd(b.usd)} of *${b.coin}* — ${fmtQty(b.qty)} at ${fmtPx(b.price)}${b.dryRun ? ' _(test mode — no real order)_' : ''}`),
    ...result.failed.map(f => `⚠️ ${f.coin} (${usd(f.usd)}) wasn't bought: ${f.error}`),
    ``,
    s.value !== null ? `*So far:* ${s.buys} buy${s.buys === 1 ? '' : 's'} · put in ${usd(s.invested)} · worth ${usd(s.value)} (${s.pnl >= 0 ? '+' : '−'}${usd(Math.abs(s.pnl))})` : `*So far:* ${s.buys} buys · put in ${usd(s.invested)}`,
    `*Next buy:* ${when(s.plan.nextDue)}, 9am${plan.mode === 'live' ? ` — keep ${usd(plan.amount)} USDT in your Spot wallet` : ''}.`,
    `_The bot never sells your savings. Prices go down as well as up — this is for months and years, not days._`,
  ];
  return lines.join('\n');
}

/**
 * Place this week's buy. `scheduled` = the 30-minute job (respects the due
 * date and the waiting rules); otherwise the user asked for it now.
 * Returns { status: 'bought'|'waiting'|'skipped'|'not-due'|'busy', message? }.
 */
async function runOne(chatId, { now = new Date(), scheduled = true } = {}) {
  const plan = await getPlan(chatId);
  if (!plan) throw new SavingsError('You have no savings plan yet. Start one with `save 10`.');
  if (scheduled && (!plan.active || !plan.nextDue || new Date(plan.nextDue) > now)) return { status: 'not-due' };
  if (!(await store.lock(K.lock(chatId), 120).catch(() => true))) return { status: 'busy' };
  // A second tap on "buy now" right after a buy (double tap) does nothing
  if (!scheduled) {
    const last = (await getLog(chatId)).filter(b => b.mode === plan.mode).at(-1);
    if (last && now.getTime() - new Date(last.at).getTime() < 2 * 60_000) {
      await store.cmd('DEL', K.lock(chatId)).catch(() => {});
      return { status: 'busy', message: `✅ Already bought a moment ago — nothing more was bought. \`save\` shows your plan.` };
    }
  }
  try {
    const due = plan.nextDue;
    const dueMs = new Date(due).getTime();
    // The next buy day after this one. A buy made by hand is an EXTRA buy and leaves the
    // schedule alone — unless this week's buy is overdue (waiting for USDT), which it replaces.
    const nextAfter = () => {
      if (!scheduled && dueMs > now.getTime()) return due;
      let n = dueMs;
      while (n <= now.getTime()) n += WEEK;
      return new Date(n).toISOString();
    };

    if (scheduled && now.getTime() - dueMs > GIVE_UP_AFTER) {
      await store.cmd('HSET', K.plan(chatId), 'nextDue', nextAfter(), 'waitDue', '');
      return { status: 'skipped', message: `🐷 ${tag(plan.mode)} · *Weekly savings skipped this week* — the USDT never arrived in your Spot wallet. Next buy: ${when(nextAfter())}, 9am.` };
    }

    let client = null;
    if (plan.mode === 'live') {
      client = await require('./tradingAccounts').getActiveClient(chatId);
      const wait = async (why) => {
        if (scheduled && plan.waitDue === due) return { status: 'waiting' }; // told them already
        if (scheduled) await store.cmd('HSET', K.plan(chatId), 'waitDue', due);
        return { status: 'waiting', message: `🐷 💰 REAL · *Weekly savings: waiting*\n${why}\nI'll try again every 30 minutes for the next few days.` };
      };
      if (!client) return await wait(`Auto-trading is off, so the bot can't buy on your Binance account. Turn it on with \`golive\`, or switch the plan to play money: \`save practice\`.`);
      const free = await client.freeBalance('USDT');
      if (free + 0.01 < plan.amount) {
        return await wait(`This week's buy needs *${usd(plan.amount)} USDT* in your Spot wallet; you have ${usd(free)}. Add USDT (Binance P2P), then move it *Funding → Spot*.`);
      }
    }

    // Never twice for the same week
    if (scheduled) {
      const first = await store.cmd('SET', K.did(chatId, due), '1', 'NX', 'EX', 14 * 86400);
      if (first !== 'OK') { await store.cmd('HSET', K.plan(chatId), 'nextDue', nextAfter()); return { status: 'not-due' }; }
    }
    const result = plan.mode === 'live' ? await buyLive(chatId, plan, client, now) : await buyPractice(chatId, plan, now);
    await store.cmd('HSET', K.plan(chatId), 'nextDue', nextAfter(), 'waitDue', '', 'remindDue', '');
    if (!result.bought.length) {
      return { status: 'failed', message: `🐷 ${tag(plan.mode)} · *Weekly savings: the buy failed*\n${result.failed.map(f => `• ${f.coin}: ${f.error}`).join('\n')}\nNothing was bought. Next try: ${when(nextAfter())} — or \`save now\` to try again.` };
    }
    const s = await summary(chatId, { mode: plan.mode });
    return { status: 'bought', result, message: boughtMessage(plan, result, s) };
  } finally {
    await store.cmd('DEL', K.lock(chatId)).catch(() => {});
  }
}

/** Day-before reminder for real plans that don't have enough USDT yet. */
async function remindOne(chatId, now = new Date()) {
  const plan = await getPlan(chatId);
  if (!plan || !plan.active || plan.mode !== 'live' || !plan.nextDue) return null;
  const until = new Date(plan.nextDue).getTime() - now.getTime();
  if (until <= 0 || until > 86_400_000 || plan.remindDue === plan.nextDue) return null;
  await store.cmd('HSET', K.plan(chatId), 'remindDue', plan.nextDue);
  const client = await require('./tradingAccounts').getActiveClient(chatId);
  const free = client ? await client.freeBalance('USDT').catch(() => null) : null;
  if (free !== null && free + 0.01 >= plan.amount) return null; // all set
  return [
    `🐷 *Savings reminder* — tomorrow at 9am the bot buys ${plan.parts.map(p => `${usd(p.usd)} of ${p.coin}`).join(' + ')}.`,
    free !== null ? `Your Spot wallet has ${usd(free)} USDT — add at least ${usd(plan.amount - free)}.` : `Auto-trading is off — turn it on with \`golive\` so the bot can buy.`,
    `_P2P USDT lands in Funding: move it Funding → Spot._`,
  ].join('\n');
}

/** The 30-minute job: reminders and due buys for everyone with access. */
async function runDue({ allowed = new Set(), send = async () => {}, now = new Date() } = {}) {
  const out = { checked: 0, bought: 0, waiting: 0, reminded: 0 };
  for (const id of ((await store.cmd('SMEMBERS', K.users)) || []).map(String)) {
    if (!allowed.has(id)) continue;
    out.checked++;
    try {
      const reminder = await remindOne(id, now);
      if (reminder) { await send(id, reminder); out.reminded++; }
      const r = await runOne(id, { now, scheduled: true });
      if (r.status === 'bought') out.bought++;
      if (r.status === 'waiting') out.waiting++;
      if (r.message) await send(id, r.message);
    } catch (err) { console.error('[Savings]', id, err.message); }
  }
  return out;
}

module.exports = {
  SavingsError, COINS, DAYS, getPlan, setPlan, setActive, stop, summary, getLog, runOne, runDue, remindOne,
  reservedUsd, liveHoldingsUsd, nextOccurrence, parseDay, parts, lagosDay, when, tag, usd,
};
