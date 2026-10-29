/**
 * Auto-buy settings: which coins, how much risk, and what it takes to unlock
 * real-money buying.
 *
 *  AUTOBUY_UNIVERSE   ALL (default) = every liquid Binance USDT spot coin, found fresh each day
 *                     BTC,ETH,…     = only those coins
 *  AUTOBUY_MIN_VOLUME_USD   ignore coins that traded less than this in 24h (default 1,000,000; 0 = no floor)
 *  AUTOBUY_MAX_COINS        look at most this many coins, most-traded first (default 400)
 *  AUTOBUY_DAILY_CLOSE      true (default) = every auto-bought position is sold at the daily run
 *                           false          = hold until the trailing stop is hit (the originally tested way)
 *
 * The 15 coins below are the CORE list: what `npm run lab` tested, and the fallback
 * if Binance's coin list can't be fetched.
 */
const CORE_UNIVERSE = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'NEAR', 'ATOM', 'UNI'];

const envList = () => (process.env.AUTOBUY_UNIVERSE || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const toPair = (s) => (s.endsWith('USDT') ? s : `${s}USDT`);

/** True when the bot should trade every liquid Binance USDT coin (the default). */
function allCoins() {
  const env = envList();
  return env.length === 0 || (env.length === 1 && env[0] === 'ALL');
}

/** The fixed coin list: your own AUTOBUY_UNIVERSE list, or the 15 core coins. (Use universe.js for "all coins".) */
function universe() {
  const env = envList();
  return (env.length && !allCoins() ? env : CORE_UNIVERSE).map(toPair);
}

const num = (name, d) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 && process.env[name] !== '' && process.env[name] !== undefined ? v : d; };
const minVolumeUsd = () => num('AUTOBUY_MIN_VOLUME_USD', 1_000_000);
const maxCoins = () => Math.max(1, Math.floor(num('AUTOBUY_MAX_COINS', 400)) || 400);
/** Sell every auto-bought position at the daily run (default on). */
const dailyClose = () => !/^(0|false|off|no)$/i.test(String(process.env.AUTOBUY_DAILY_CLOSE ?? 'true').trim());

module.exports = {
  CORE_UNIVERSE, allCoins, universe, minVolumeUsd, maxCoins, dailyClose,
  // Safety limits (practice AND live)
  LIMITS: {
    riskPct: 1,          // % of the account lost if a trade hits its first stop
    maxPositionPct: 20,  // no single coin bigger than this % of the account
    maxOpen: 5,          // at most this many auto-bought positions at once
    dailyLossPct: 3,     // if the account fell this much today, no new buys today
    minOrderUsd: 5,      // Binance's own Spot minimum for most USDT pairs (some coins need more; Binance's rule is checked too)
  },
  // What live auto-buy needs before the admin can unlock it
  GATE: {
    researchVerdict: 'PASS', // from `npm run lab` → data/auto-strategy.json
    forwardDays: 56,         // the house practice account has run for 8+ weeks
    forwardTrades: 20,       // with at least 20 closed trades
    forwardProfit: true,     // and made money after fees
  },
  // Used only if data/auto-strategy.json (the saved `npm run lab` result) is missing.
  // These are the settings that PASSED the 3,000-day lab test (Oct 2026), so a
  // missing file never switches the bot to an untested strategy. Without the
  // file the verdict still shows "NOT TESTED", so live auto-buy can't be unlocked
  // on it, and the health check and the admin's daily report warn about it.
  FALLBACK: { family: 'donchian', params: { entryN: 55, exitN: 20, regime: true }, id: 'donchian:55-20:btc' },
  STRATEGY_FILE: 'data/auto-strategy.json',
  DAILY_RUN_AFTER_UTC_MINUTES: 5, // run each day at 00:05 UTC or later (after the daily candle closes)
};
