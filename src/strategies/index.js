/**
 * ─── Auto-buy strategy families (daily candles) ──────────────────────────────
 * Shared by the research tool (src/services/strategyLab.js) and the live /
 * practice auto-buyer (src/services/autoBuyer.js), so what is tested is exactly
 * what runs.
 *
 * Every strategy is: an ENTRY rule checked at the daily close (buy at the next
 * open), an initial stop, and a TRAILING stop that only moves up. Exits are by
 * stop only, so practice, live and backtests handle them identically.
 *
 *   donchian   Breakout to a new N-day high (the classic "turtle" rule);
 *              trail = lowest low of the last M days
 *   emaTrend   Uptrend (fast EMA > slow EMA, price > 200-day EMA) and price
 *              crosses back above the fast EMA; trail = highest close − k·ATR
 *   momentum   Coin is in the top-N of the universe by L-day return (and that
 *              return is positive, price above its 50-day EMA); trail = k·ATR
 *
 * Optional market filter on all: only buy while BTC closes above its 100-day
 * average ("regime").
 */

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === n - 1) prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else if (i >= n) prev = values[i] * k + prev * (1 - k);
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Wilder ATR */
function atr(c, n = 20) {
  const out = new Array(c.length).fill(null);
  let prev = null;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i < n) { prev = (prev ?? 0) + tr; if (i === n - 1) { prev /= n - 1; out[i] = prev; } continue; }
    prev = (prev * (n - 1) + tr) / n;
    out[i] = prev;
  }
  return out;
}

/** Highest high / lowest low of the n bars BEFORE i (excludes bar i). */
function priorHigh(c, i, n) { let m = -Infinity; for (let j = Math.max(0, i - n); j < i; j++) m = Math.max(m, c[j].high); return i - n >= 0 ? m : null; }
function priorLow(c, i, n) { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, c[j].low); return i - n + 1 >= 0 ? m : null; }

/** Indicators for one coin's daily candles (computed once, used by every variant). */
function prepare(c) {
  const close = c.map(x => x.close);
  return {
    c, close,
    ema: { 20: ema(close, 20), 50: ema(close, 50), 100: ema(close, 100), 200: ema(close, 200) },
    sma100: sma(close, 100),
    atr: atr(c, 20),
    timeIndex: new Map(c.map((x, i) => [x.time, i])),
  };
}

const ret = (ind, i, n) => (i - n >= 0 ? ind.close[i] / ind.close[i - n] - 1 : null);

/** Price for messages: whole dollars from $1,000, up to 4 decimals from $1, 4 significant digits below. */
const $ = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p < 1) return `$${Number(p).toPrecision(4)}`;
  // $1,000 and up: whole dollars ($104,250). Below that: 2–4 decimals ($182.41, $1.2345).
  // (minimumFractionDigits must never be above maximumFractionDigits, or toLocaleString throws.)
  const digits = p >= 1000 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 4 };
  return `$${Number(p).toLocaleString('en-US', digits)}`;
};
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const STRATEGIES = {
  donchian: {
    name: 'Breakout to a new high',
    grid: [
      { entryN: 20, exitN: 10 }, { entryN: 55, exitN: 20 }, { entryN: 55, exitN: 10 },
    ],
    warmup: 60,
    describe: (p) => `buy a close above the ${p.entryN}-day high; exit on a ${p.exitN}-day low`,
    entry(ind, i, p) { const h = priorHigh(ind.c, i, p.entryN); return h !== null && ind.close[i] > h; },
    initialStop(ind, i, p, entry) { return Math.min(priorLow(ind.c, i, p.exitN) ?? entry * 0.9, entry - 2 * ind.atr[i]); },
    trail(ind, i, p) { return priorLow(ind.c, i, p.exitN); },
    /** Why it signalled (or how far it is from signalling). gap = % rise still needed. */
    explain(ind, i, p) {
      const h = priorHigh(ind.c, i, p.entryN);
      const c = ind.close[i];
      if (h === null) return { text: 'not enough history yet', gap: null };
      return c > h
        ? { text: `Breakout: closed at ${$(c)}, above its ${p.entryN}-day high of ${$(h)} (${pct(c / h - 1)}) — a new high`, gap: 0 }
        : { text: `needs a close above its ${p.entryN}-day high of ${$(h)} (${pct(h / c - 1)} from ${$(c)})`, gap: h / c - 1 };
    },
    exitText: (p) => `the stop follows the lowest low of the last ${p.exitN} days and only ever moves up; when the price falls to it, the bot sells`,
  },
  emaTrend: {
    name: 'Trend pullback',
    grid: [
      { fast: 20, slow: 50, k: 3 }, { fast: 20, slow: 50, k: 4 }, { fast: 20, slow: 100, k: 3 }, { fast: 20, slow: 100, k: 4 },
    ],
    warmup: 210,
    describe: (p) => `uptrend (EMA${p.fast} > EMA${p.slow} > EMA200) and a close back above EMA${p.fast}; trail ${p.k}×ATR`,
    entry(ind, i, p) {
      const f = ind.ema[p.fast], s = ind.ema[p.slow], l = ind.ema[200];
      if (i < 1 || f[i] === null || s[i] === null || l[i] === null || f[i - 1] === null) return false;
      return f[i] > s[i] && ind.close[i] > l[i] && ind.close[i] > f[i] && ind.close[i - 1] <= f[i - 1];
    },
    initialStop(ind, i, p, entry) { return entry - p.k * ind.atr[i]; },
    trail(ind, i, p, pos) { return pos.highestClose - p.k * ind.atr[i]; },
    explain(ind, i, p) {
      const f = ind.ema[p.fast][i], s = ind.ema[p.slow][i], l = ind.ema[200][i];
      if (f === null || s === null || l === null) return { text: 'not enough history yet', gap: null };
      const ok = this.entry(ind, i, p);
      return {
        text: ok
          ? `Trend pullback: uptrend (EMA${p.fast} ${$(f)} > EMA${p.slow} ${$(s)}, price above the 200-day average ${$(l)}) and it closed back above EMA${p.fast} today at ${$(ind.close[i])}`
          : `needs an uptrend (EMA${p.fast} above EMA${p.slow}, price above ${$(l)}) and a close back above EMA${p.fast} (${$(f)})`,
        gap: ok ? 0 : null,
      };
    },
    exitText: (p) => `the stop trails ${p.k}× the coin's average daily range below its highest close and only ever moves up; when the price falls to it, the bot sells`,
  },
  momentum: {
    name: 'Strongest coins',
    grid: [
      { lookback: 28, topN: 3, k: 3 }, { lookback: 28, topN: 3, k: 4 }, { lookback: 56, topN: 3, k: 3 }, { lookback: 56, topN: 3, k: 4 },
    ],
    warmup: 60,
    cross: true, // needs the whole universe (ranking)
    describe: (p) => `a top-${p.topN} coin by ${p.lookback}-day return, rising and above its 50-day EMA; trail ${p.k}×ATR`,
    entry(ind, i, p, ctx) {
      const r = ret(ind, i, p.lookback);
      if (r === null || r <= 0 || ind.ema[50][i] === null || ind.close[i] <= ind.ema[50][i]) return false;
      return ctx.rank(ind.symbol, ind.c[i].time, p.lookback) < p.topN;
    },
    initialStop(ind, i, p, entry) { return entry - p.k * ind.atr[i]; },
    trail(ind, i, p, pos) { return pos.highestClose - p.k * ind.atr[i]; },
    explain(ind, i, p, ctx) {
      const r = ret(ind, i, p.lookback);
      if (r === null) return { text: 'not enough history yet', gap: null };
      const rank = ctx ? ctx.rank(ind.symbol, ind.c[i].time, p.lookback) + 1 : null;
      const ok = this.entry(ind, i, p, ctx);
      return {
        text: ok
          ? `Strongest coins: #${rank} of the list by ${p.lookback}-day return (${pct(r)}), and above its 50-day average`
          : `ranked #${rank ?? '?'} by ${p.lookback}-day return (${pct(r)}); needs top ${p.topN}, a positive return and a price above its 50-day average`,
        gap: ok ? 0 : null,
      };
    },
    exitText: (p) => `the stop trails ${p.k}× the coin's average daily range below its highest close and only ever moves up; when the price falls to it, the bot sells`,
  },
};

/** Every variant: each family × its grid × with / without the BTC market filter. */
function variants() {
  const out = [];
  for (const [family, s] of Object.entries(STRATEGIES)) {
    for (const g of s.grid) {
      for (const regime of [true, false]) {
        const params = { ...g, regime };
        out.push({ family, params, id: `${family}:${Object.values(g).join('-')}${regime ? ':btc' : ''}`, label: `${s.name} — ${s.describe(params)}${regime ? ', only while BTC is above its 100-day average' : ''}` });
      }
    }
  }
  return out;
}

/** Cross-coin context: BTC market filter + momentum ranks. */
function makeContext(prepared, btc) {
  const rankCache = new Map();
  return {
    btcUp(time) {
      if (!btc) return true;
      const i = btc.timeIndex.get(time);
      if (i === undefined || btc.sma100[i] === null) return false;
      return btc.close[i] > btc.sma100[i];
    },
    /** BTC's close and 100-day average on that day (for messages). */
    btcAt(time) {
      const i = btc?.timeIndex.get(time);
      return i === undefined ? null : { close: btc.close[i], sma100: btc.sma100[i] };
    },
    rank(symbol, time, lookback) {
      const key = `${time}|${lookback}`;
      if (!rankCache.has(key)) {
        const list = [];
        for (const ind of Object.values(prepared)) {
          const i = ind.timeIndex.get(time);
          if (i === undefined) continue;
          const r = ret(ind, i, lookback);
          if (r !== null) list.push([ind.symbol, r]);
        }
        list.sort((a, b) => b[1] - a[1]);
        rankCache.set(key, new Map(list.map(([s], k) => [s, k])));
      }
      return rankCache.get(key).get(symbol) ?? Infinity;
    },
  };
}

module.exports = { STRATEGIES, variants, prepare, makeContext, ema, sma, atr, priorHigh, priorLow, fmtUsd: $ };
