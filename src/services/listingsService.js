/**
 * ─── Listings Service ─────────────────────────────────────────────────────────
 * Binance for market data (KuCoin only if Binance can't be reached) + CoinGecko
 * for metadata + probabilityEngine for scoring.
 *
 * v2.20.3: scan / moonshots / split look at BINANCE coins, so every pick can be
 * bought where the bot trades (Buy Now, auto-trading). Before, they only looked
 * at KuCoin, and many picks weren't on Binance at all.
 *
 * RELIABILITY (v2.5): the old version made ~90 calls one after another
 * (2 CoinGecko + 1 KuCoin per coin × 30 coins). CoinGecko's free tier allows
 * roughly 30 per minute, so many failed and those coins were scored as if
 * their market cap were unknown. Now:
 *  - one batch CoinGecko call gets price + market cap for all candidates
 *  - contract addresses are fetched only for the coins actually shown (top 5)
 *  - KuCoin candle calls run 5 at a time
 *  - every call retries on 429 / 5xx, honouring Retry-After
 */

const { calculateProbability } = require('./probabilityEngine');
const { getWithRetry } = require('../lib/http');
const { mapLimit } = require('../lib/concurrency');
const { binanceGet } = require('../lib/market');

const KUCOIN_BASE    = 'https://api.kucoin.com/api/v1';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

const ESTABLISHED = new Set([
  'BTC','ETH','BNB','XRP','ADA','SOL','DOGE','DOT','MATIC','LTC',
  'LINK','AVAX','UNI','ATOM','ETC','XLM','ALGO','VET','TRX','FIL',
  'AAVE','MKR','COMP','YFI','SUSHI','CRV','SNX','RUNE','ICP','NEAR',
  'FTM','SAND','MANA','AXS','GALA','ENJ','CHZ','BAT','GRT','INJ',
  'APT','GMT','LDO','STG','APE','OP','ARB','SUI','PEPE','WLD','SEI',
  'TIA','KAS','ORDI','WIF','JUP','BONK','PYTH','BOME','MEME','NOT',
  'ZK','TURBO','DOGS','GOAT','POPCAT','ME','MOVE','VIRTUAL','TRUMP',
  'EIGEN','CATI','STRK','PIXEL','PORTAL','AEVO','ACT','DRIFT',
]);

// Not coins to scan: stablecoins, fiat, gold and wrapped tokens
const NOT_COINS = new Set([
  'USDC','FDUSD','TUSD','USDP','DAI','BUSD','USDS','USDE','USD1','RLUSD','BFUSD','XUSD','PYUSD','USTC',
  'EUR','EURI','AEUR','GBP','TRY','BRL','PAXG','XAUT','WBTC','WBETH','BETH','BNSOL',
]);

const CHAIN_LABELS = {
  'ethereum':            'Ethereum (ERC-20)',
  'binance-smart-chain': 'BNB Chain (BEP-20)',
  'solana':              'Solana (SPL)',
  'arbitrum-one':        'Arbitrum',
  'base':                'Base',
  'polygon-pos':         'Polygon',
  'avalanche':           'Avalanche',
  'sui':                 'Sui',
  'tron':                'Tron (TRC-20)',
  'ton':                 'TON',
  'optimistic-ethereum': 'Optimism',
};

// ─── CoinGecko: batch market data for many symbols in ONE call ───────────────
async function getMarketsBySymbols(symbols) {
  const out = new Map();
  const list = [...new Set(symbols.map(s => s.toLowerCase()))];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const r = await getWithRetry(`${COINGECKO_BASE}/coins/markets`, {
        params: { vs_currency: 'usd', symbols: chunk.join(','), include_tokens: 'top', per_page: 250 },
        timeout: 10000,
      });
      for (const c of r.data || []) {
        const sym = String(c.symbol || '').toUpperCase();
        // keep the largest coin if several share a ticker
        if (!out.has(sym) || (c.market_cap || 0) > (out.get(sym).marketCap || 0)) {
          out.set(sym, {
            id: c.id,
            name: c.name,
            symbol: sym,
            currentPrice: c.current_price ?? null,
            priceChange24h: c.price_change_percentage_24h ?? null,
            marketCap: c.market_cap || null,
            volume24h: c.total_volume || null,
            contracts: [],
            contractsUnknown: true,
            isNativeAsset: false,
            cgUrl: `https://www.coingecko.com/en/coins/${c.id}`,
          });
        }
      }
    } catch (err) {
      console.warn('[Listings] CoinGecko batch failed:', err.message);
    }
  }
  return out;
}

// ─── CoinGecko full detail (contracts, description) ──────────────────────────
async function getCoinDetail(symbolOrId, isId = false) {
  try {
    let cgId = symbolOrId;
    if (!isId) {
      const s = await getWithRetry(`${COINGECKO_BASE}/search`, { params: { query: symbolOrId }, timeout: 6000 });
      const match = (s.data.coins || []).find(c => c.symbol.toUpperCase() === symbolOrId.toUpperCase()) || s.data.coins?.[0];
      if (!match) return null;
      cgId = match.id;
    }

    const r = await getWithRetry(`${COINGECKO_BASE}/coins/${cgId}`, {
      params: { localization: false, tickers: false, market_data: true, community_data: false, developer_data: false },
      timeout: 8000,
    });

    const coin      = r.data;
    const md        = coin.market_data || {};
    const platforms = coin.platforms   || {};
    const contracts = Object.entries(platforms)
      .filter(([, a]) => a && a.length > 5)
      .map(([chain, address]) => ({ chain, address, chainLabel: CHAIN_LABELS[chain] || chain }));

    return {
      id:             coin.id,
      name:           coin.name,
      symbol:         coin.symbol?.toUpperCase(),
      description:    (coin.description?.en || '').split('.')[0].slice(0, 120),
      currentPrice:   md.current_price?.usd ?? null,
      priceChange24h: md.price_change_percentage_24h ?? null,
      marketCap:      md.market_cap?.usd || null,
      volume24h:      md.total_volume?.usd || null,
      contracts,
      isNativeAsset:  contracts.length === 0,
      contractsUnknown: false,
      cgUrl:          `https://www.coingecko.com/en/coins/${coin.id}`,
    };
  } catch { return null; }
}

/** Batch metadata, falling back to per-coin lookups (max 8) if the batch call failed. */
async function getMetaForSymbols(symbols) {
  const metas = await getMarketsBySymbols(symbols);
  if (metas.size === 0) {
    const fallback = await mapLimit(symbols.slice(0, 8), 2, (s) => getCoinDetail(s));
    symbols.slice(0, 8).forEach((s, i) => { if (fallback[i]) metas.set(s.toUpperCase(), fallback[i]); });
  }
  return metas;
}

/** Add contract addresses + description for the coins we actually show. */
async function enrichWithDetails(coins, getMeta, setMeta) {
  await mapLimit(coins, 2, async (coin) => {
    const meta = getMeta(coin);
    if (meta && !meta.contractsUnknown) return;
    const detail = await getCoinDetail(meta?.id || coin.base || coin.symbol, !!meta?.id);
    if (detail) setMeta(coin, { ...(meta || {}), ...detail });
  });
}

// ─── Binance tickers ──────────────────────────────────────────────────────────
async function getBinanceTickers() {
  const r = await binanceGet('/ticker/24hr');
  const rows = Array.isArray(r?.data) ? r.data : [];
  if (!rows.length) throw new Error('Binance tickers unavailable');
  const fresh = Date.now() - 2 * 3_600_000; // delisted pairs stop updating
  return rows
    .map(t => ({ t, base: String(t.symbol || '').replace(/USDT$/, '') }))
    .filter(({ t, base }) => {
      const vol    = parseFloat(t.quoteVolume) || 0;
      const change = parseFloat(t.priceChangePercent);
      return String(t.symbol).endsWith('USDT') && base && !ESTABLISHED.has(base) && !NOT_COINS.has(base) &&
        Number(t.count) > 0 && Number(t.closeTime) >= fresh &&
        vol >= 200_000 && change > 0 && change < 600 && parseFloat(t.lastPrice) > 0;
    })
    .map(({ t, base }) => ({
      exchange:      'binance',
      binanceSymbol: t.symbol,
      base,
      price:         parseFloat(t.lastPrice),
      change24h:     parseFloat(t.priceChangePercent),
      volume:        parseFloat(t.quoteVolume),
      high24h:       parseFloat(t.highPrice),
      low24h:        parseFloat(t.lowPrice),
      tradeCount:    parseInt(t.count || 0, 10),
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 30); // top 30 by volume go to deep analysis
}

/** Binance coins; KuCoin only if Binance can't be reached. Tagged with the source. */
async function getScanTickers() {
  try {
    return { source: 'Binance', tickers: await getBinanceTickers() };
  } catch (err) {
    console.warn('[Listings] Binance tickers failed, using KuCoin:', err.message);
    return { source: 'KuCoin', tickers: await getKuCoinTickers() };
  }
}

// ─── KuCoin tickers ───────────────────────────────────────────────────────────
async function getKuCoinTickers() {
  const r = await getWithRetry(`${KUCOIN_BASE}/market/allTickers`, { timeout: 12000 });
  if (!r.data?.data?.ticker) throw new Error('KuCoin API unavailable');

  return r.data.data.ticker
    .filter(t => {
      const base   = t.symbol.replace('-USDT', '');
      const vol    = parseFloat(t.volValue) || 0;
      const change = parseFloat(t.changeRate) * 100;
      return t.symbol.endsWith('-USDT') && !ESTABLISHED.has(base) &&
        vol >= 200_000 && change > 0 && change < 600 && parseFloat(t.last) > 0;
    })
    .map(t => ({
      kuCoinSymbol: t.symbol,
      base:         t.symbol.replace('-USDT', ''),
      price:        parseFloat(t.last),
      change24h:    parseFloat(t.changeRate) * 100,
      volume:       parseFloat(t.volValue),
      high24h:      parseFloat(t.high),
      low24h:       parseFloat(t.low),
      tradeCount:   parseInt(t.count || 0, 10),
      exchange:     'kucoin',
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 30); // top 30 by volume go to deep analysis
}

async function getTrendingSymbols() {
  try {
    const r = await getWithRetry(`${COINGECKO_BASE}/search/trending`, { timeout: 8000 }, { retries: 1 });
    return r.data.coins || [];
  } catch { return []; }
}

// ─── Main: getMoonshots ───────────────────────────────────────────────────────
async function getMoonshots() {
  const [{ source, tickers }, trendingCoins] = await Promise.all([getScanTickers(), getTrendingSymbols()]);
  const trendingSymbols = new Set(trendingCoins.map(c => c.item.symbol.toUpperCase()));
  const metas = await getMetaForSymbols(tickers.map(t => t.base));

  const scored = await mapLimit(tickers, 5, async (coin) => {
    const meta = metas.get(coin.base.toUpperCase()) || null;
    const prob = await calculateProbability(coin, meta, trendingSymbols);
    return { coin, meta, prob };
  });

  const results = scored
    .filter(s => s.prob.probability >= 55)
    .map(({ coin, meta, prob }) => ({
      ...coin,
      meta,
      probability:    prob.probability,
      band:           prob.band,
      positionAdvice: prob.positionAdvice,
      factors:        prob.factors,
      greenSignals:   prob.greenSignals,
      redFlags:       prob.redFlags,
      skipReason:     prob.skipReason,
      isTrending:     trendingSymbols.has(coin.base.toUpperCase()),
    }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5);

  await enrichWithDetails(results, c => c.meta, (c, m) => { c.meta = m; });
  return Object.assign(results, { source });
}

// ─── Main: getNewListingsWithMetadata ─────────────────────────────────────────
async function getNewListingsWithMetadata() {
  const [tickers, trendingCoins] = await Promise.all([getKuCoinTickers(), getTrendingSymbols()]);
  const hot = tickers.slice(0, 5);
  const metas = await getMetaForSymbols(hot.map(t => t.base));
  const hotCoins = hot.map(coin => ({ ...coin, meta: metas.get(coin.base.toUpperCase()) || null }));
  await enrichWithDetails(hotCoins, c => c.meta, (c, m) => { c.meta = m; });

  const trending = (await mapLimit(trendingCoins.slice(0, 5), 2, async (c) => {
    const detail = await getCoinDetail(c.item.id, true);
    return detail ? { ...detail, trendScore: c.item.score } : null;
  })).filter(Boolean);

  return { hotCoins, trending };
}

module.exports = { getMoonshots, getBinanceTickers, getScanTickers, getNewListingsWithMetadata, getMarketsBySymbols, getCoinDetail };
