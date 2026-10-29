# How honest is the strategy? (v2.3.0)

This bot now measures its own BUY signals instead of claiming a "confidence %".

## What gets tested

The backtester (`src/services/strategyBacktest.js`) replays history through **the exact function the live scanner uses** (`evaluateSignal` in `src/services/scanEngine.js`). It uses the same candle windows (260 × 4H, 100 × 1H, 50 × 15M), and only candles that had closed at the time.

Each BUY is traded exactly the way the Telegram alert tells you to:

| Step | Rule |
|---|---|
| Entry | Next 15M candle's **open**, plus slippage (you can't buy at the close that created the signal) |
| Stop | The alert's stop price (1.5 × 1H ATR below the signal price) |
| TP1 (1.5R) | Sell 40% → move stop to breakeven |
| TP2 (2.5R) | Sell 35% → move stop to TP1 |
| TP3 (4R) | Sell the remaining 25% |
| Same candle hits stop and target | Counted as a **loss** (conservative) |
| Price gaps below the stop | Filled at the gap price, not the stop |
| Costs | 0.1% fee on every buy and sell (Binance spot taker) + 0.05% slippage on market fills |
| Sizing | 1% of the account risked per trade, no leverage, one position per coin |

All of these can be changed from the command line (see below).

## How to read the results

- **Avg per trade (R)** is the most important number. R is the amount you risk on a trade (entry minus stop). **+0.20R** means risking $10 per trade earned $2 per trade on average. **Below 0, the strategy lost money.** Below +0.05R is called "roughly breakeven", because the edge is too small to rely on.
- **Win rate** comes with a **95% range**. 12 wins out of 20 is "60%", but the honest range is about 39–78%. With fewer than **30 trades**, results are flagged as too few to trust.
- **Profit factor** is total winnings ÷ total losses, after fees. Above 1 is profitable.
- **Max drawdown** is the worst fall from a peak in account value.
- **Buy & hold** is what simply holding the coin did over the same period. If the strategy can't beat it, ask why you're trading.
- **By setup score** shows whether higher scores actually did better. If they didn't, the score isn't adding information.

A full stop costs more than −1R once fees and slippage are included (around −1.2R with the defaults). The stops are tight (1.5 × 1H ATR), so costs are a big share of the risk.

## Where the numbers appear

- **Every BUY alert in Telegram** carries a line like: *Backtest Apr–Oct 2026, all signals, fees incl.: 64 trades · 47% win (likely 35–59%) · avg +0.12R per trade*. If the strategy lost money in testing, the alert says so.
- **Dashboard → Track Record tab** shows the full tables.
- **`/api/backtest`** returns the raw JSON.

The old "Confidence 73%" bar (score ÷ 15) is gone. The setup score (x/15) is still shown, labelled as what it is: how many conditions lined up, not a probability.

## Running it

Run it from a computer that can reach Binance; Kraken alone has too little history.

```bash
npm run backtest                                      # BINANCE_SYMBOLS, last 180 days
npm run backtest -- --days 365                        # longer history = more trades = more trustworthy
npm run backtest -- --symbols SOLUSDT,ETHUSDT
npm run backtest -- --fee 0.075 --slippage 0.1        # BNB fee discount, more slippage
npm run backtest -- --max-hold-hours 72               # add a time stop
```

Then **commit and push `data/strategy-stats.json`** so the deployed bot shows the numbers. Re-run monthly; markets change.

## Research result (October 2026)

`npm run research` tested 48 variants on 12 coins over 365 days:
- decision on 15m or 1h closes;
- stops of 1.5×, 2.5× or 3.5× the 1H ATR;
- no filter, a coin-trend filter, a BTC-trend filter, or both;
- 4h or 24h between entries.

It chose a variant on the first 8 months and judged it once on the last 4.

- Every variant lost money on the first 8 months (best: −0.088R per trade).
- On the unseen months, the original lost −0.113R per trade (95% range −0.20 to −0.03R).
- The chosen variant (3.5× stop, 24h gap) made +0.028R, but its 95% range was −0.15 to +0.20R: indistinguishable from zero.
- **Verdict: no reliable edge. BUY alerts should stay off.**

To re-run: `npm run research` (add `-- --days 540` for more history). If a future variant passes, the tool prints the settings for `src/config/strategy.js`, the one file that controls the live scanner and the backtest.

## What is still NOT tested

- **Moonshot / scan / listings scores (0–92).** They depend on CoinGecko and KuCoin snapshots that have no free history, so they can't be backtested here. Every message now labels them as a heuristic score, not a probability.
- **Exits from `check` / `v2advice` advice** (e.g. "close partial when MACD fades"). The backtest follows the alert's fixed plan only.
- **Past performance does not predict future results.** A positive backtest is necessary, not sufficient.

## v2.23: every coin, closed daily (NOT back-tested)

The lab result in `data/auto-strategy.json` (PASS) tested *breakout to a new 55-day high, only while BTC is above its 100-day average, exit on a 20-day low* on **15 coins**, holding each trade about 33 days on average. Since v2.23 the live bot:

1. applies the same entry rule to **every liquid Binance USDT coin** (`npm run lab -- --all --top 100` tests the 100 most-traded ones), and
2. **sells every auto-bought position at the next daily run** instead of waiting for the trailing stop.

Neither change has been back-tested. Closing early cuts the big winners that made the original result positive, and each sell-and-rebuy costs roughly 0.3% (0.1% fee + 0.05% slippage, each way). Treat v2.23 as a new experiment: run it in practice/house mode, compare with `AUTOBUY_DAILY_CLOSE=false`, and only then consider real money.
