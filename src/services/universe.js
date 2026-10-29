/**
 * ─── Coin universe: every Binance USDT spot coin worth trading ───────────────
 * Used by the daily auto-buy so ONE strategy is applied to every coin on
 * Binance, not just a fixed list.
 *
 * Source: Binance's own lists — exchangeInfo (is it TRADING and spot-tradable?)
 * and the 24h ticker (how much traded). Kept, most-traded first:
 *   • USDT-quoted, status TRADING, spot trading allowed
 *   • not a stablecoin / fiat-pegged coin (they never "break out")
 *   • traded at least AUTOBUY_MIN_VOLUME_USD in the last 24h (default $1M;
 *     set 0 to include literally everything, thin coins included)
 *   • at most AUTOBUY_MAX_COINS (default 400)
 * Coins with fewer than ~120 days of history are skipped later by the strategy.
 *
 * Cached 6 hours (Redis + memory). If Binance can't be reached the 15 core
 * coins are used, so the daily check never fails because of this step.
 */
const store = require('../lib/redis');
const { binanceGet } = require('../lib/market');
const cfg = require('../config/autobuy');

const CACHE_KEY = 'cryptobot:autobuy:universe';
const CACHE_SECONDS = 6 * 3600;

// Coins pegged to a currency or gold-like wrapper: a "breakout to a new high" means nothing on them.
const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDD', 'USDE', 'USD1', 'BFUSD', 'XUSD', 'RLUSD', 'PYUSD', 'USDS', 'UST',
  'AEUR', 'EUR', 'EURI', 'EURT', 'GBP', 'TRY', 'BRL', 'AUD', 'JPY', 'ARS', 'MXN', 'PLN', 'RON', 'UAH', 'CZK', 'COP', 'ZAR', 'NGN',
]);

let memo = null; // { at, key, list }
const memKey = () => `${cfg.minVolumeUsd()}|${cfg.maxCoins()}`;

function pickFromTickers(tickers, tradable, { minVolume, max }) {
  const rows = [];
  for (const t of Array.isArray(tickers) ? tickers : []) {
    const sym = String(t?.symbol || '');
    if (!/^[A-Z0-9]{2,20}USDT$/.test(sym)) continue;
    const base = sym.slice(0, -4);
    if (STABLE_BASES.has(base)) continue;
    if (tradable && !tradable.has(sym)) continue;
    const vol = Number(t.quoteVolume);
    if (!Number.isFinite(vol) || vol < Math.max(0, minVolume) || (minVolume === 0 && vol <= 0)) continue;
    rows.push([sym, vol]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  return rows.slice(0, max).map(([s]) => s);
}

async function fetchTradable() {
  try {
    const r = await binanceGet('/exchangeInfo', { params: { symbolStatus: 'TRADING' }, timeout: 20000 });
    const list = r?.data?.symbols;
    if (!Array.isArray(list) || !list.length) return null;
    return new Set(list.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed !== false).map(s => s.symbol));
  } catch { return null; } // the 24h ticker alone is enough to carry on
}

/**
 * @returns {Promise<{symbols: string[], source: 'all'|'list'|'core-fallback', total: number}>}
 */
async function resolveUniverse({ force = false, top = null } = {}) {
  if (!cfg.allCoins()) { const l = cfg.universe(); return { symbols: l, source: 'list', total: l.length }; }
  const max = top || cfg.maxCoins();
  const key = `${cfg.minVolumeUsd()}|${max}`;
  if (!force && memo && memo.key === key && Date.now() - memo.at < CACHE_SECONDS * 1000) return { symbols: memo.list, source: 'all', total: memo.list.length };
  if (!force) {
    const hit = await store.getJSON(CACHE_KEY, null).catch(() => null);
    if (hit && hit.key === key && Array.isArray(hit.list) && hit.list.length && Date.now() - hit.at < CACHE_SECONDS * 1000) {
      memo = hit;
      return { symbols: hit.list, source: 'all', total: hit.list.length };
    }
  }
  try {
    const r = await binanceGet('/ticker/24hr', { timeout: 20000 });
    const tradable = await fetchTradable();
    const list = pickFromTickers(r?.data, tradable, { minVolume: cfg.minVolumeUsd(), max });
    if (list.length < 10) throw new Error(`only ${list.length} coins came back`);
    memo = { at: Date.now(), key, list };
    await store.setJSON(CACHE_KEY, memo).catch(() => {});
    return { symbols: list, source: 'all', total: list.length };
  } catch (err) {
    console.error('[Universe] using the 15 core coins:', err.message);
    const l = cfg.CORE_UNIVERSE.map(s => `${s}USDT`);
    return { symbols: l, source: 'core-fallback', total: l.length };
  }
}

const _reset = () => { memo = null; };
module.exports = { resolveUniverse, pickFromTickers, STABLE_BASES, _reset };
