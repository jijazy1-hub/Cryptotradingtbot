/**
 * ─── Probability Engine ───────────────────────────────────────────────────────
 * Multi-factor analysis that gives an HONEST probability score.
 *
 * WHAT THE OLD SYSTEM GOT WRONG:
 *  - Called everything "99%" based on volume + price change alone
 *  - Volume can be faked (wash trading)
 *  - Price change can be the END of a pump, not the start
 *  - No check for dump risk, rug pull signals, or whale exits
 *
 * WHAT THIS ENGINE CHECKS (7 independent factors):
 *  1. Volume Quality     — is volume real or wash traded?
 *  2. Price Structure    — is this early stage or already topped?
 *  3. Market Cap Risk    — too small = easy to manipulate
 *  4. Liquidity Health   — can you actually exit without crashing price?
 *  5. Momentum Trend     — is buying pressure building or fading?
 *  6. Social Signal      — real organic interest or bot activity?
 *  7. Red Flag Detector  — dump patterns, suspicious behaviour
 *
 * HONEST PROBABILITY BANDS:
 *  85-95% → Very High Confidence  (rare — requires all factors green)
 *  70-84% → High Confidence       (most signals aligned)
 *  55-69% → Moderate              (mixed signals — size down)
 *  40-54% → Low                   (speculative — only for gamblers)
 *  <40%   → Skip                  (not worth the risk)
 */

const { getWithRetry } = require('../lib/http');

const KUCOIN_BASE    = 'https://api.kucoin.com/api/v1';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// ─── Factor 1: Volume Quality ─────────────────────────────────────────────────
// Checks if volume is genuine or likely wash-traded
function analyseVolumeQuality(coin) {
  const result = { score: 0, max: 20, flags: [], green: [] };

  const vol      = coin.volume;
  const price    = coin.price;
  const change   = coin.change24h;
  const trades   = coin.tradeCount || 0;

  // Real pumps have high trade COUNT, not just high volume
  // Wash trading = high volume but low trade count
  const avgTradeSize = trades > 0 ? vol / trades : vol;

  if (trades > 100_000) {
    result.score += 8;
    result.green.push(`${trades.toLocaleString()} individual trades — genuine retail interest`);
  } else if (trades > 30_000) {
    result.score += 5;
    result.green.push(`${trades.toLocaleString()} trades — moderate retail interest`);
  } else if (trades > 5_000) {
    result.score += 2;
    result.flags.push(`Only ${trades.toLocaleString()} trades — volume may not be organic`);
  } else if (trades > 0) {
    result.score -= 5;
    result.flags.push(`⚠️ Very few trades (${trades.toLocaleString()}) with high volume — likely wash trading`);
  }

  // Volume should scale with price change — if not, it's suspicious
  if (vol > 5_000_000 && change > 20) {
    result.score += 7;
    result.green.push(`$${(vol/1e6).toFixed(1)}M volume confirms +${change.toFixed(0)}% move is real`);
  } else if (vol > 1_000_000 && change > 10) {
    result.score += 4;
    result.green.push(`Volume supports price move`);
  } else if (vol < 500_000 && change > 50) {
    result.score -= 8;
    result.flags.push(`⚠️ +${change.toFixed(0)}% move on only $${(vol/1000).toFixed(0)}K volume — easy to fake`);
  }

  // Minimum volume for safe entry/exit
  if (vol >= 3_000_000) {
    result.score += 5;
    result.green.push('Enough volume to enter and exit without major slippage');
  } else if (vol >= 1_000_000) {
    result.score += 2;
  } else {
    result.score -= 3;
    result.flags.push('⚠️ Low volume — large orders will move price against you');
  }

  return result;
}

// ─── Factor 2: Price Structure ────────────────────────────────────────────────
// Is this the START of a move or the END?
function analysePriceStructure(coin) {
  const result = { score: 0, max: 20, flags: [], green: [] };

  const change   = coin.change24h;
  const rangePos = coin.high24h > coin.low24h
    ? (coin.price - coin.low24h) / (coin.high24h - coin.low24h)
    : 0.5;

  // The BEST entry is: price up 10-40%, consolidating, not yet overbought
  // The WORST entry is: price already up 200%+ (you are the exit liquidity)
  if (change > 200) {
    result.score -= 10;
    result.flags.push(`🚨 +${change.toFixed(0)}% already — likely near the top. Late entry = bag holding`);
  } else if (change > 100) {
    result.score -= 5;
    result.flags.push(`⚠️ +${change.toFixed(0)}% already — significant move, higher risk of reversal`);
  } else if (change >= 15 && change <= 60) {
    result.score += 15;
    result.green.push(`+${change.toFixed(0)}% — healthy early-stage momentum, not yet overbought`);
  } else if (change >= 5 && change < 15) {
    result.score += 8;
    result.green.push(`+${change.toFixed(0)}% — early move, best risk/reward entry point`);
  } else if (change < 5) {
    result.score += 3;
    result.flags.push('Minimal price movement — waiting for catalyst');
  }

  // Price position in range
  // Below 40% of range = pullback (great entry)
  // 40-75% = middle (good entry)
  // Above 85% = extended (risky entry)
  if (rangePos < 0.40) {
    result.score += 5;
    result.green.push('Price pulled back from highs — better risk/reward entry');
  } else if (rangePos <= 0.75) {
    result.score += 3;
    result.green.push('Price in healthy mid-range position');
  } else {
    result.score += 0;
    result.flags.push('Price near 24H high — buying at peak carries reversal risk');
  }

  return result;
}

// ─── Factor 3: Market Cap Risk ────────────────────────────────────────────────
// Tiny market caps = easy to pump AND dump
function analyseMarketCapRisk(meta) {
  const result = { score: 0, max: 15, flags: [], green: [] };

  if (!meta?.marketCap) {
    result.flags.push('⚠️ Market cap unknown — could not verify size');
    return result;
  }

  const mc = meta.marketCap;

  if (mc > 500_000_000) {
    result.score += 5;
    result.green.push(`$${(mc/1e6).toFixed(0)}M market cap — large, harder to manipulate`);
    result.flags.push('Large cap = lower chance of 5X, but lower dump risk too');
  } else if (mc > 100_000_000) {
    result.score += 10;
    result.green.push(`$${(mc/1e6).toFixed(0)}M market cap — mid cap, balanced risk/reward`);
  } else if (mc > 20_000_000) {
    result.score += 15;
    result.green.push(`$${(mc/1e6).toFixed(0)}M market cap — small cap, high upside potential`);
  } else if (mc > 5_000_000) {
    result.score += 10;
    result.flags.push(`$${(mc/1e6).toFixed(1)}M market cap — micro cap, very volatile`);
  } else if (mc > 1_000_000) {
    result.score += 5;
    result.flags.push(`⚠️ $${(mc/1e6).toFixed(1)}M market cap — nano cap, extreme manipulation risk`);
  } else {
    result.score -= 5;
    result.flags.push(`🚨 Under $1M market cap — extremely easy to rug pull or dump`);
  }

  return result;
}

// ─── Factor 4: Liquidity Health ───────────────────────────────────────────────
// Can you actually get OUT of this trade without destroying the price?
function analyseLiquidity(coin, meta) {
  const result = { score: 0, max: 15, flags: [], green: [] };

  const vol = coin.volume;
  const mc  = meta?.marketCap;

  // Volume-to-MarketCap ratio
  // > 100% = extremely high turnover (often manipulation)
  // 20-100% = very active trading
  // 5-20%   = healthy
  // < 5%    = illiquid, hard to exit

  if (mc && mc > 0) {
    const vtmRatio = (vol / mc) * 100;

    if (vtmRatio > 200) {
      result.score -= 5;
      result.flags.push(`🚨 Volume is ${vtmRatio.toFixed(0)}% of market cap — extreme, likely manipulation`);
    } else if (vtmRatio > 50) {
      result.score += 5;
      result.flags.push(`Volume is ${vtmRatio.toFixed(0)}% of market cap — very active (watch for dump)`);
    } else if (vtmRatio >= 10) {
      result.score += 15;
      result.green.push(`Healthy volume-to-market cap ratio (${vtmRatio.toFixed(0)}%) — good liquidity`);
    } else if (vtmRatio >= 3) {
      result.score += 8;
      result.green.push(`Adequate liquidity for trading`);
    } else {
      result.score -= 3;
      result.flags.push(`⚠️ Low volume relative to market cap — you may struggle to exit`);
    }
  } else {
    // No market cap data — use raw volume
    if (vol > 5_000_000)      { result.score += 12; result.green.push('High absolute volume — good liquidity'); }
    else if (vol > 1_000_000) { result.score += 7;  result.green.push('Adequate trading volume'); }
    else                      { result.score += 2;  result.flags.push('Low volume — exit may be difficult'); }
  }

  return result;
}

/**
 * Last 24 hourly candles, oldest first, from the exchange the coin was found on:
 * Binance (coin.binanceSymbol, e.g. "ABCUSDT") or KuCoin ("ABC-USDT").
 */
async function hourlyCandles(coinOrSymbol) {
  const coin = typeof coinOrSymbol === 'string' ? { kuCoinSymbol: coinOrSymbol } : (coinOrSymbol || {});
  if (coin.binanceSymbol) {
    const { fetchKlines } = require('../lib/market');
    return fetchKlines(coin.binanceSymbol, '1h', 24, { exchange: 'binance' });
  }
  const r = await getWithRetry(`${KUCOIN_BASE}/market/candles`, {
    params: { symbol: coin.kuCoinSymbol || `${coin.base}-USDT`, type: '1hour', pageSize: 24 },
    timeout: 8000,
  });
  // KuCoin candles, newest first: [time, open, close, high, low, volume, turnover]
  return (r.data?.data || []).slice().reverse().map(c => ({
    open: parseFloat(c[1]), close: parseFloat(c[2]),
    high: parseFloat(c[3]), low: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ─── Factor 5: Momentum Trend ─────────────────────────────────────────────────
// Is buying pressure building or fading?
async function analyseMomentum(coinOrSymbol) {
  const result = { score: 0, max: 15, flags: [], green: [] };

  try {
    const candles = await hourlyCandles(coinOrSymbol);
    if (!candles || candles.length < 6) {
      result.flags.push('Limited price history — momentum unverifiable');
      return result;
    }

    const n = candles.length;

    // Volume trend: is volume increasing or decreasing?
    const recentVol = candles.slice(-3).reduce((s, c) => s + c.volume, 0) / 3;
    const earlierVol = candles.slice(0, 3).reduce((s, c) => s + c.volume, 0) / 3;
    const volTrend = earlierVol > 0 ? recentVol / earlierVol : 1;

    if (volTrend > 2.5) {
      result.score += 8;
      result.green.push('Volume accelerating — buying pressure increasing rapidly');
    } else if (volTrend > 1.3) {
      result.score += 5;
      result.green.push('Volume trending up — momentum building');
    } else if (volTrend < 0.5) {
      result.score -= 5;
      result.flags.push('⚠️ Volume declining — momentum fading, pump may be over');
    }

    // Price trend: consecutive up candles?
    const lastCandles = candles.slice(-4);
    const upCandles   = lastCandles.filter(c => c.close > c.open).length;

    if (upCandles >= 3) {
      result.score += 7;
      result.green.push(`${upCandles}/4 recent candles bullish — consistent buying`);
    } else if (upCandles === 2) {
      result.score += 3;
      result.green.push('Mixed momentum — watch for confirmation');
    } else {
      result.score -= 3;
      result.flags.push('⚠️ Recent candles mostly bearish — momentum weakening');
    }

    // Higher lows pattern (accumulation signal)
    const lows = candles.slice(-6).map(c => c.low);
    const higherLows = lows.every((l, i) => i === 0 || l >= lows[i - 1] * 0.97);
    if (higherLows) {
      result.score += 5; // bonus not in max — reward for strong pattern
      result.green.push('Higher lows pattern — smart money accumulating');
    }

  } catch (err) {
    result.flags.push('Could not verify momentum from candle data');
  }

  return result;
}

// ─── Factor 6: Social Signal ──────────────────────────────────────────────────
// Organic interest vs bot activity
function analyseSocialSignal(coin, meta, trendingSymbols) {
  const result = { score: 0, max: 10, flags: [], green: [] };

  const isTrending = trendingSymbols.has(coin.base?.toUpperCase());

  if (isTrending) {
    result.score += 10;
    result.green.push('🔥 Trending on CoinGecko — organic social interest confirmed');
  } else {
    result.score += 2;
    result.flags.push('Not currently trending on CoinGecko — limited social momentum');
  }

  return result;
}

// ─── Factor 7: Red Flag Detector ─────────────────────────────────────────────
// Hard disqualifiers — things that should make you walk away
function detectRedFlags(coin, meta) {
  const flags   = [];
  const bonuses  = [];
  let penalty    = 0;

  const change = coin.change24h;
  const vol    = coin.volume;
  const trades = coin.tradeCount || 0;
  const mc     = meta?.marketCap;
  const contracts = meta?.contracts || [];

  // Already pumped massively — you are the exit liquidity
  if (change > 500) {
    flags.push('🚨 CRITICAL: +500% already — extremely high dump risk. Avoid.');
    penalty -= 30;
  } else if (change > 200) {
    flags.push('🚨 +200% already — very likely near top. Risk outweighs reward.');
    penalty -= 20;
  }

  // No contract address = unverifiable token
  // contractsUnknown: metadata came from the batch endpoint, which has no
  // contract info — don't penalise for something we simply didn't fetch.
  if (contracts.length === 0 && !meta?.isNativeAsset && !meta?.contractsUnknown) {
    flags.push('⚠️ Contract address not found — cannot verify token legitimacy');
    penalty -= 5;
  }

  // Suspicious volume/trade ratio
  if (trades > 0 && vol / trades > 50_000) {
    flags.push('⚠️ Very large average trade size — possible whale manipulation');
    penalty -= 5;
  }

  // Micro cap with massive volume = pump and dump setup
  if (mc && mc < 2_000_000 && vol > 5_000_000) {
    flags.push('🚨 Volume is far larger than market cap — classic pump and dump pattern');
    penalty -= 15;
  }

  // No market cap data
  if (!mc) {
    flags.push('⚠️ Market cap not available — extra caution required');
    penalty -= 3;
  }

  // Positive signals
  if (contracts.length > 1) {
    bonuses.push('Multi-chain deployment — legitimate project signal');
  }
  if (meta?.marketCap > 50_000_000) {
    bonuses.push('Established market cap — lower rug pull risk');
  }

  return { flags, bonuses, penalty };
}

// ─── Master Probability Calculator ───────────────────────────────────────────
async function calculateProbability(coin, meta, trendingSymbols) {
  // Run all 7 factors
  const [f1, f2, f3, f4, f5, f6] = await Promise.all([
    Promise.resolve(analyseVolumeQuality(coin)),
    Promise.resolve(analysePriceStructure(coin)),
    Promise.resolve(analyseMarketCapRisk(meta)),
    Promise.resolve(analyseLiquidity(coin, meta)),
    analyseMomentum(coin),
    Promise.resolve(analyseSocialSignal(coin, meta, trendingSymbols)),
  ]);
  const f7 = detectRedFlags(coin, meta);

  // Raw score out of 95 (sum of all factor maxes)
  const rawScore = f1.score + f2.score + f3.score + f4.score + f5.score + f6.score + f7.penalty;
  const maxScore = f1.max + f2.max + f3.max + f4.max + f5.max + f6.max;

  // Honest probability — capped at 92% (nothing is 100% in crypto)
  const probability = Math.max(0, Math.min(92, Math.round((rawScore / maxScore) * 92)));

  // Confidence band
  const band = probability >= 80 ? 'VERY HIGH'
    : probability >= 65 ? 'HIGH'
    : probability >= 50 ? 'MODERATE'
    : probability >= 35 ? 'LOW'
    : 'VERY LOW';

  // Recommended position size based on confidence
  const positionAdvice = probability >= 80 ? 'Max 2% of account'
    : probability >= 65 ? 'Max 1% of account'
    : probability >= 50 ? 'Max 0.5% of account — speculative'
    : 'Avoid — risk too high';

  // Collect all green signals and red flags
  const allGreen = [
    ...f1.green, ...f2.green, ...f3.green,
    ...f4.green, ...f5.green, ...f6.green, ...f7.bonuses,
  ];
  const allFlags = [
    ...f1.flags, ...f2.flags, ...f3.flags,
    ...f4.flags, ...f5.flags, ...f6.flags, ...f7.flags,
  ];

  return {
    probability,
    band,
    positionAdvice,
    rawScore,
    maxScore,
    factors: {
      volumeQuality:  { score: f1.score, max: f1.max },
      priceStructure: { score: f2.score, max: f2.max },
      marketCapRisk:  { score: f3.score, max: f3.max },
      liquidity:      { score: f4.score, max: f4.max },
      momentum:       { score: f5.score, max: f5.max },
      socialSignal:   { score: f6.score, max: f6.max },
      redFlagPenalty: f7.penalty,
    },
    greenSignals: allGreen,
    redFlags:     allFlags,
    skipReason:   probability < 40 ? 'Probability too low — not worth the risk' : null,
  };
}

module.exports = { calculateProbability };