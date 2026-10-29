/**
 * ─── What to expect for your amount ───────────────────────────────────────────
 * Turns the strategy's honest test result (the 1%-risk portfolio on the unseen
 * period, from `npm run lab` → data/auto-strategy.json) into plain dollar
 * figures for a given account size: average per month, per year, the worst
 * drop seen, and whether auto-buy can trade at all with that much.
 *
 * Everything comes from the saved lab result, so it updates whenever the lab
 * is re-run. If the file is missing, the Oct 2026 result is used.
 */

const cfg = require('../config/autobuy');

const DAY = 86_400_000;

// The 3,000-day lab result of 26 Oct 2026 — used only if data/auto-strategy.json is missing
const FALLBACK = { from: '2023-12-11', to: '2026-10-26', returnPct: 21.5, maxDrawdownPct: 4.2, trades: 108, btcHoldPct: 94.3 };

// A typical stop is about 10% below the buy price (range ~6–20%)
const TYPICAL_STOP = 0.10;

function stats() {
  let res = null;
  try { res = require('./autoBuyer').loadResearch(); } catch { /* use the fallback */ }
  const pt = res?.pick?.portfolioTest;
  const s = pt && res?.period?.split && res?.period?.to
    ? { from: res.period.split, to: res.period.to, returnPct: pt.returnPct, maxDrawdownPct: pt.maxDrawdownPct, trades: res.pick.test?.trades ?? null, btcHoldPct: res.btcBuyHoldTestPct ?? null, fromLab: true }
    : { ...FALLBACK, fromLab: false };
  const years = Math.max(0.25, (new Date(s.to) - new Date(s.from)) / DAY / 365.25);
  const growth = 1 + s.returnPct / 100;
  const yearlyPct = (growth > 0 ? growth ** (1 / years) - 1 : -1) * 100;
  const monthlyPct = (growth > 0 ? growth ** (1 / (years * 12)) - 1 : -1) * 100;
  const buysPerMonth = s.trades ? s.trades / (years * 12) : null;
  return { ...s, years, yearlyPct, monthlyPct, buysPerMonth };
}

/** The smallest account auto-buy can trade with (Binance's minimum order at 1% risk). */
function minAutoBuyAccount() {
  const riskFrac = cfg.LIMITS.riskPct / 100;
  return Math.ceil(cfg.LIMITS.minOrderUsd * TYPICAL_STOP / riskFrac); // $5 × 10% ÷ 1% = $50
}

function estimate(amount) {
  const a = Number(amount);
  if (!(a > 0)) throw new Error('amount must be positive');
  const s = stats();
  return {
    amount: a,
    perMonthUsd: a * s.monthlyPct / 100,
    perYearUsd: a * s.yearlyPct / 100,
    worstDropUsd: a * s.maxDrawdownPct / 100,
    autoBuyWorks: a >= minAutoBuyAccount(),
    minAutoBuy: minAutoBuyAccount(),
    stats: s,
  };
}

const money = (n) => {
  const v = Math.abs(n);
  const s = v >= 100 || (Number.isInteger(v) && v >= 1) ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2);
  return `$${s}`;
};
const pct = (n, d = 1) => `${Number(n).toFixed(d)}%`;
const monthName = (iso) => new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The full "what to expect" message for one amount. */
function message(amount) {
  const e = estimate(amount);
  const s = e.stats;
  const lines = [
    `📏 *What to expect with ${money(e.amount)}*`,
    ``,
    `From the strategy's test on ${s.years.toFixed(1)} years of prices it was never tuned on (${monthName(s.from)} → ${monthName(s.to)}), with fees:`,
    ``,
    `• *On average per month:* about +${money(e.perMonthUsd)} (${pct(s.monthlyPct, 2)})`,
    `• *On average per year:* about +${money(e.perYearUsd)} (${pct(s.yearlyPct)})`,
    `• *Worst drop in the test:* about −${money(e.worstDropUsd)} (${pct(s.maxDrawdownPct)})`,
    s.buysPerMonth ? `• *Buys:* about ${Math.max(1, Math.round(s.buysPerMonth))} a month across all coins — some weeks none` : null,
    ``,
    `Many months are flat or slightly down; the gains come from a few good trades. These are averages from the past, not a promise.`,
    s.btcHoldPct != null ? `_For comparison, simply holding BTC made +${Math.round(s.btcHoldPct)}% in the same period — with much bigger drops on the way._` : null,
  ];
  if (!e.autoBuyWorks) {
    lines.push(``, `⚠️ *With ${money(e.amount)}, auto-buy can't place trades yet.* Binance's minimum order is $${cfg.LIMITS.minOrderUsd}, and at 1% risk that needs about *${money(e.minAutoBuy)}* in your account (some coins need more).`);
  }
  if (e.amount < 500) {
    lines.push(``, `💡 *For a small account, adding money matters more than any strategy.* Put in $10 a week and after a year you've added $520. Set it up with \`save 10\` — the bot buys BTC/ETH for you every week.`);
  }
  lines.push(``, `Try another amount: \`expect 100\``);
  return lines.filter(x => x !== null).join('\n');
}

/** A short table for the go-live intro. */
function table(amounts = [20, 50, 100, 500, 1000]) {
  const s = stats();
  const rows = amounts.map(a => {
    const e = estimate(a);
    return `• ${money(a)} → about +${money(e.perMonthUsd)}/month · +${money(e.perYearUsd)}/year${e.autoBuyWorks ? '' : ' _(too small for auto-buy)_'}`;
  });
  return [
    `📏 *What to expect* (average from the strategy's test, ${pct(s.yearlyPct)} a year — some months lose):`,
    ...rows,
  ].join('\n');
}

module.exports = { stats, estimate, message, table, minAutoBuyAccount, FALLBACK };
