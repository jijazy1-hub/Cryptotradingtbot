/**
 * ─── V2 New Listing Scanner with BUY/SELL Signals ────────────────────────────
 * GET /api/v2listings
 *
 * Now includes: Coin full name + contract address per chain (via CoinGecko)
 */

const {
  ema, rsi, stochRsi, bollingerBands, atr,
  obv, vwap, volumeAvg, detectPatterns,
} = require('../src/services/indicatorService');
const {
  calcATRStop, calcTakeProfits, calcRiskReward,
  claimSignal, releaseSignal,
} = require('../src/services/riskService');
const { sendListingBuyAlert } = require('../src/services/telegramService');
const { cors, mayAlert } = require('../src/lib/auth');

const axios = require('axios');
const { fetchKlines, binanceGet, KRAKEN_BASE } = require('../src/lib/market');
const { getMarketsBySymbols, getCoinDetail } = require('../src/services/listingsService');
const { mapLimit } = require('../src/lib/concurrency');

// ─── Established Coins (excluded) ────────────────────────────────────────────
const ESTABLISHED = new Set([
  'BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','ADAUSDT','SOLUSDT','DOGEUSDT',
  'DOTUSDT','MATICUSDT','LTCUSDT','LINKUSDT','AVAXUSDT','UNIUSDT','ATOMUSDT',
  'ETCUSDT','XLMUSDT','ALGOUSDT','VETUSDT','TRXUSDT','FILUSDT','AAVEUSDT',
  'MKRUSDT','COMPUSDT','YFIUSDT','SUSHIUSDT','CRVUSDT','SNXUSDT','UMAUSDT',
  'RUNEUSDT','ICPUSDT','NEARUSDT','FTMUSDT','SANDUSDT','MANAUSDT','AXSUSDT',
  'GALAUSDT','ENJUSDT','CHZUSDT','BATUSDT','ZRXUSDT','STORJUSDT','AUDIOUSDT',
  'FLOWUSDT','HBARUSDT','EGLDUSDT','THETAUSDT','XTZUSDT','IOTAUSDT','NEOUSDT',
  'QTUMUSDT','ONTUSDT','ZILUSDT','RVNUSDT','SCUSDT','DCRUSDT','ZECUSDT',
  'DASHUSDT','WAVESUSDT','ZENUSDT','IOSTUSDT','KSMUSDT','IOTXUSDT','RSRUSDT',
  'LRCUSDT','COTIUSDT','SLPUSDT','SKLUSDT','CELRUSDT','BANDUSDT','KNCUSDT',
  'STMXUSDT','BLZUSDT','CVCUSDT','GRTUSDT','INJUSDT','ALPHAUSDT','AIONUSDT',
  'LPTUSDT','NUUSDT','NKNUSDT','DATAUSDT','RIFUSDT','PONDUSDT','ALICEUSDT',
  'CHRUSDT','ERNUSDT','KLAYUSDT','PHBUSDT','AGLDUSDT','RADUSDT','QNTUSDT',
  'APTUSDT','GMTUSDT','LDOUSDT','STGUSDT','SPELLUSDT','LOOMUSDT','APEUSDT',
  'GALUSDT','OPUSDT','ASTRUSDT','HOOKUSDT','MAGICUSDT','HFTUSDT','GLMUSDT',
  'HIGHUSDT','ARBUSDT','SUIUSDT','PEPEUSDT','WLDUSDT','SEIUSDT','CYBERUSDT',
  'TIAUSDT','MNTUSDT','KASUSDT','ORDIUSDT','SATSUDT','ACEUSDT','NFPUSDT',
  'AIUSDT','XAIUSDT','WIFUSDT','JUPUSDT','STRKUSDT','PIXELUSDT','PORTALUSDT',
  'PYTHUSDT','BONKUSDT','BOMEUSDT','AEVOUSDT','MEMEUSDT','CATIUSDT','EIGENUSDT',
  'NOTUSDT','IOUSDT','LISTAUSDT','ZKUSDT','BBUSDT','TURBOUSDT','DOGSUSDT',
  'GOATUSDT','POPCATUSDT','ACTUSDT','MEUSDT','MOVEUSDT','VIRTUALUSDT',
  'DRIFTUSDT','ZEREBROUSDT','AIXBTUSDT','FARTCOINUSDT','TRUMPUSDT',
]);

// ─── Coin metadata & candles (shared helpers with retries + fallbacks) ──────
// Names for every candidate come from ONE batch CoinGecko call; contract
// addresses are only fetched for coins that produce a BUY (they go in the alert).
async function fetchCoinCandles(symbol) {
  try {
    const [candles1h, candles15m] = await Promise.all([
      fetchKlines(symbol, '1h', 100, { closedOnly: true }),
      fetchKlines(symbol, '15m', 50, { closedOnly: true }),
    ]);
    return { candles1h, candles15m };
  } catch {
    return null;
  }
}

// ─── Technical Analysis (adapted for new listings) ───────────────────────────
function analyzeNewListing(candles1h, candles15m) {
  const n1  = candles1h.length;
  const n15 = candles15m.length;

  if (n1 < 20) {
    return {
      signal: 'WATCH',
      reason: `Only ${n1} candles — too early for technical analysis`,
      earlyStage: true,
      candleCount: n1,
    };
  }

  const closes1h   = candles1h.map(c => c.close);
  const entryPrice = n15 > 0 ? candles15m[n15 - 1].close : closes1h[n1 - 1];

  const emaPFast  = Math.min(20, Math.floor(n1 / 2));
  const emaPSlow  = Math.min(50, Math.floor(n1 * 0.8));
  const rsiPeriod = Math.min(14, n1 - 2);

  const emaFast   = ema(closes1h, emaPFast)[n1 - 1];
  const emaSlow   = ema(closes1h, emaPSlow)[n1 - 1];
  const rsiArr    = rsi(closes1h, rsiPeriod);
  const rsiNow    = rsiArr[n1 - 1];
  const srsi      = stochRsi(closes1h, rsiPeriod);
  const atrArr    = atr(candles1h, Math.min(14, n1 - 2));
  const atrNow    = atrArr[n1 - 1];
  const bbArr     = bollingerBands(closes1h, Math.min(20, n1 - 1));
  const bbNow     = bbArr[n1 - 1];
  const vwapArr   = vwap(candles1h);
  const vwapNow   = vwapArr[n1 - 1];
  const obvArr    = obv(candles1h);
  const obvEmaArr = ema(obvArr, Math.min(10, n1 - 1));
  const obvTrend  = obvArr[n1 - 1] > (obvEmaArr[n1 - 1] || 0) ? 'BULLISH' : 'BEARISH';

  const patterns   = n15 >= 3 ? detectPatterns(candles15m) : [];
  const bullishPat = patterns.filter(p => p.bullish === true);
  const bearishPat = patterns.filter(p => p.bullish === false);

  const avgVol   = volumeAvg(candles1h, Math.min(10, n1 - 1));
  const volSurge = avgVol > 0 && candles1h[n1 - 1].volume > avgVol * 2;

  let score = 0;
  const factors  = [];
  const warnings = [];

  const inUptrend = emaFast && emaSlow && emaFast > emaSlow;
  if (inUptrend)                                { score += 2; factors.push(`EMA${emaPFast} above EMA${emaPSlow} — uptrend`); }
  else                                          { warnings.push('Short-term EMAs bearish — wait for trend'); }
  if (entryPrice > (vwapNow || 0))              { score += 1; factors.push('Price above VWAP — buyers in control'); }

  if (rsiNow !== undefined) {
    if (rsiNow >= 40 && rsiNow <= 65)           { score += 2; factors.push(`RSI ${rsiNow.toFixed(1)} — healthy momentum`); }
    else if (rsiNow > 75)                       { score -= 1; warnings.push(`RSI ${rsiNow.toFixed(1)} — overbought, dump risk`); }
    else if (rsiNow < 35)                       { score += 1; factors.push(`RSI ${rsiNow.toFixed(1)} — oversold bounce setup`); }
  }
  if (srsi.k !== undefined && srsi.k < 30)      { score += 1; factors.push(`StochRSI ${srsi.k.toFixed(1)} — oversold entry`); }
  if (srsi.kCrossedAboveD)                       { score += 1; factors.push('StochRSI bullish cross'); }

  if (obvTrend === 'BULLISH')                   { score += 2; factors.push('OBV rising — accumulation confirmed'); }
  else                                          { warnings.push('OBV bearish — smart money not yet buying'); }
  if (volSurge)                                 { score += 1; factors.push('Volume surge — strong buying interest'); }

  if (bbNow && bbNow.percentB < 0.3)            { score += 1; factors.push(`BB %B ${(bbNow.percentB * 100).toFixed(0)}% — near lower band`); }

  if (bearishPat.length > 0) {
    score -= bearishPat.reduce((s, p) => s + p.strength, 0);
    warnings.push(`Bearish 15M patterns: ${bearishPat.map(p => p.name).join(', ')}`);
  }
  if (bullishPat.length > 0) {
    score += Math.min(bullishPat.reduce((s, p) => s + p.strength, 0), 2);
    factors.push(`Bullish 15M patterns: ${bullishPat.map(p => p.name).join(', ')}`);
  }

  const stopLoss  = calcATRStop({ entryPrice, atrValue: atrNow, multiplier: 2.0 });
  const tps       = stopLoss ? calcTakeProfits({ entryPrice, stopLoss }) : null;
  const rr        = tps && stopLoss ? calcRiskReward({ entryPrice, stopLoss, takeProfit: tps.tp1.price }) : null;

  const confidence = Math.min(100, Math.round((Math.max(score, 0) / 12) * 100));
  const signal     = score >= 6 && inUptrend && (rr === null || rr >= 1.5) ? 'BUY' : 'WATCH';

  return {
    signal, score, confidence, factors, warnings, patterns,
    earlyStage: n1 < 50, candleCount: n1,
    entryPrice, stopLoss, takeProfits: tps, riskReward: rr,
    indicators: {
      rsi:        rsiNow  ? parseFloat(rsiNow.toFixed(2))  : null,
      stochRsiK:  srsi.k  ? parseFloat(srsi.k.toFixed(2))  : null,
      emaFast:    emaFast ? parseFloat(emaFast.toFixed(6))  : null,
      emaSlow:    emaSlow ? parseFloat(emaSlow.toFixed(6))  : null,
      atr:        atrNow  ? parseFloat(atrNow.toFixed(6))   : null,
      vwap:       vwapNow ? parseFloat(vwapNow.toFixed(6))  : null,
      obvTrend,
      bbPercentB: bbNow   ? parseFloat(bbNow.percentB.toFixed(3)) : null,
    },
  };
}

// ─── Risk Flags ───────────────────────────────────────────────────────────────
function assessRisk(t) {
  const flags = [];
  const vol    = parseFloat(t.quoteVolume);
  const change = parseFloat(t.priceChangePercent);
  const count  = parseInt(t.count, 10);
  const price  = parseFloat(t.lastPrice);
  const high   = parseFloat(t.highPrice);
  const low    = parseFloat(t.lowPrice);

  if (vol < 500_000)                      flags.push('LOW_LIQUIDITY');
  if (change < -40)                       flags.push('POSSIBLE_DUMP');
  if (count < 500)                        flags.push('VERY_LOW_ACTIVITY');
  if (price < 0.0001)                     flags.push('MICRO_CAP_EXTREME');
  if (high > 0 && low > 0 && high/low > 5) flags.push('EXTREME_VOLATILITY');
  if (change > 100 && count < 2000)       flags.push('POSSIBLE_WASH_TRADE');
  return flags;
}

// ─── First-pass pump scorer ───────────────────────────────────────────────────
function scoreTicker(t) {
  let score = 0;
  const factors = [];
  const priceChange = parseFloat(t.priceChangePercent);
  const volume      = parseFloat(t.quoteVolume);
  const count       = parseInt(t.count, 10);
  const lastPrice   = parseFloat(t.lastPrice);
  const high24h     = parseFloat(t.highPrice);
  const low24h      = parseFloat(t.lowPrice);
  const rangePos    = high24h > low24h ? (lastPrice - low24h) / (high24h - low24h) : 0.5;

  if (priceChange > 150)       { score += 5; factors.push(`+${priceChange.toFixed(0)}% parabolic`); }
  else if (priceChange > 80)   { score += 4; factors.push(`+${priceChange.toFixed(0)}% explosive`); }
  else if (priceChange > 40)   { score += 3; factors.push(`+${priceChange.toFixed(0)}% strong pump`); }
  else if (priceChange > 15)   { score += 2; factors.push(`+${priceChange.toFixed(0)}% notable`); }
  else if (priceChange > 5)    { score += 1; factors.push(`+${priceChange.toFixed(0)}% early move`); }

  if (volume > 50_000_000)     { score += 4; factors.push(`$${(volume/1e6).toFixed(0)}M vol`); }
  else if (volume > 10_000_000){ score += 3; factors.push(`$${(volume/1e6).toFixed(1)}M vol`); }
  else if (volume > 2_000_000) { score += 2; factors.push(`$${(volume/1e6).toFixed(1)}M vol`); }
  else if (volume > 500_000)   { score += 1; factors.push(`$${(volume/1e3).toFixed(0)}K vol`); }

  if (count > 200_000)         { score += 2; factors.push(`${count.toLocaleString()} trades`); }
  else if (count > 50_000)     { score += 1; factors.push(`${count.toLocaleString()} trades`); }

  if (rangePos > 0.80)         { score += 1; factors.push('Near 24H high'); }

  return { score, factors, priceChange, volume, count, lastPrice, high24h, low24h, rangePos };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const alerting = mayAlert(req);
    const [tickerResp, exchangeResp, krakenResp] = await Promise.allSettled([
      binanceGet('/ticker/24hr'),
      binanceGet('/exchangeInfo'),
      axios.get(`${KRAKEN_BASE}/AssetPairs`,    { timeout: 10000 }),
    ]);

    if (tickerResp.status === 'rejected') {
      return res.status(500).json({ success: false, error: 'Binance API unavailable' });
    }

    const allTickers = tickerResp.value.data;

    // Build baseAsset map from exchangeInfo (symbol → full base asset name)
    const baseAssetMap = {};
    if (exchangeResp.status === 'fulfilled') {
      exchangeResp.value.data.symbols.forEach(s => {
        baseAssetMap[s.symbol] = s.baseAsset;
      });
    }

    const allSymbols = new Set(Object.keys(baseAssetMap).length > 0
      ? Object.keys(baseAssetMap)
      : allTickers.map(t => t.symbol));

    const krakenSymbols = new Set();
    if (krakenResp.status === 'fulfilled') {
      Object.values(krakenResp.value.data.result || {}).forEach(p => {
        krakenSymbols.add(p.altname);
        krakenSymbols.add((p.base || '').replace(/^[XZ]/, ''));
      });
    }

    // Filter candidates
    const candidates = allTickers.filter(t =>
      t.symbol.endsWith('USDT') &&
      !ESTABLISHED.has(t.symbol) &&
      allSymbols.has(t.symbol) &&
      parseFloat(t.quoteVolume) >= 500_000 &&
      !assessRisk(t).includes('POSSIBLE_DUMP')
    );

    // First pass — score by pump signals
    const firstPass = candidates
      .map(t => {
        const riskFlags = assessRisk(t);
        const scored    = scoreTicker(t);
        return {
          symbol:     t.symbol,
          baseAsset:  baseAssetMap[t.symbol] || t.symbol.replace('USDT', ''),
          price:      scored.lastPrice,
          priceChange: scored.priceChange,
          volume:     scored.volume,
          tradeCount: scored.count,
          high24h:    scored.high24h,
          low24h:     scored.low24h,
          pumpScore:  scored.score,
          pumpFactors: scored.factors,
          pumpRating: scored.score >= 9 ? 'HOT' : scored.score >= 6 ? 'WARM' : 'COLD',
          riskFlags,
          onKraken:   krakenSymbols.has(t.symbol.replace('USDT', '')),
        };
      })
      .filter(c => c.pumpRating === 'HOT' || c.pumpRating === 'WARM')
      .sort((a, b) => b.pumpScore - a.pumpScore)
      .slice(0, 15);

    // Deep analysis — candles + technicals (4 coins at a time), names in one batch call
    const names = await getMarketsBySymbols(firstPass.map(c => c.baseAsset));
    const results = await mapLimit(firstPass, 4, async (coin) => {
      const ohlc = await fetchCoinCandles(coin.symbol);
      const named = names.get(coin.baseAsset.toUpperCase()) || null;
      if (!ohlc) return { ...coin, signal: 'WATCH', reason: 'Could not fetch candle data', coinName: named?.name || coin.baseAsset };

      const analysis = analyzeNewListing(ohlc.candles1h, ohlc.candles15m);
      // Contract addresses only for BUYs (they're shown in the alert)
      const metadata = analysis.signal === 'BUY'
        ? (await getCoinDetail(named?.id || coin.baseAsset, !!named?.id)) || named
        : named;

      return {
        symbol:      coin.symbol,
        baseAsset:   coin.baseAsset,
        exchange:    'Binance',
        coinName:    metadata?.name        || coin.baseAsset,
        coinId:      metadata?.id          || null,
        description: metadata?.description || null,
        contracts:   metadata?.contracts   || [],
        isNativeAsset: metadata?.contractsUnknown ? false : (metadata?.isNativeAsset || false),
        coingeckoUrl: metadata?.cgUrl       || null,
        price:       coin.price,
        priceChange: coin.priceChange,
        volume:      coin.volume,
        tradeCount:  coin.tradeCount,
        pumpRating:  coin.pumpRating,
        pumpScore:   coin.pumpScore,
        pumpFactors: coin.pumpFactors,
        riskFlags:   coin.riskFlags,
        onKraken:    coin.onKraken,
        ...analysis,
        scannedAt: new Date().toISOString(),
      };
    });

    // Telegram alerts for BUY signals — only on keyed (cron) calls when
    // CRON_SECRET is set, claimed atomically (no double alerts), awaited.
    for (const result of results) {
      if (alerting && result.signal === 'BUY' && (await claimSignal(result.symbol, 'LISTING_BUY'))) {
        try {
          await sendListingBuyAlert(result);
        } catch (e) {
          await releaseSignal(result.symbol, 'LISTING_BUY');
          console.error('[TG LISTING] Alert error:', e.message);
        }
      }
    }

    results.sort((a, b) => {
      if (a.signal === 'BUY' && b.signal !== 'BUY') return -1;
      if (b.signal === 'BUY' && a.signal !== 'BUY') return  1;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    return res.status(200).json({
      success:      true,
      totalScanned: candidates.length,
      buySignals:   results.filter(r => r.signal === 'BUY').length,
      alertsSent:   alerting,
      results,
      scannedAt:    new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};