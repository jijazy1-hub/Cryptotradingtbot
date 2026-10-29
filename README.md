# JijazyBot (CryptoBot V2)

A Telegram trading assistant that runs on Vercel serverless functions. It **can buy and sell on each user's own Binance account** (only when the user connects a key and switches it on; keys that can withdraw are refused, and the bot never holds anyone's money).

- **Practice mode:** $10,000 of play money at live Binance prices, with real fees and slippage.
- **Auto-buy:** once a day it checks one tested strategy (breakout to a new 55-day high, only while BTC is above its 100-day average) on **every liquid Binance USDT coin**, buys the ones that signal, and tells you *why* it bought each one. **Every auto-bought trade is closed at the next daily run** (`AUTOBUY_DAILY_CLOSE=false` to hold until the trailing stop instead). Practice for everyone; real money only once the admin opens it (see `STRATEGY.md` and `autobuy`).
- **⚡ Buy Now:** the user picks the coin; the bot buys it, places the stop order on Binance and trails it.
- **Auto-exits:** real stop orders on Binance, sales at take-profits or the trailing stop.
- **Position alerts:** stop-loss, take-profit, target and milestone alerts for positions logged on 7 exchanges, sent to each user's own chat.
- **Honest track record:** the strategies are backtested with fees and slippage. The original signal scanner showed no edge, so its alerts stay off.
- **Scan / moonshots:** Binance USDT coins with strong momentum (KuCoin only if Binance is unreachable), with a heuristic score (not backtested, labelled as such).
- **Navigation:** every screen has a ⬅️ Back button, and tapping a button removes the screen it was on.
- **Dashboard:** `/dashboard`. Send `/dashboard` to the bot for a private login link.
- **🐷 Weekly savings plan:** `save 10` — every week on the user's day (9am Lagos) the bot buys a fixed amount of BTC/ETH on their Binance account (or with play money). It never sells savings; it reminds users the day before if their USDT isn't in Spot yet.
- **📏 What to expect:** `expect 50` turns the strategy's test result into honest dollar figures for any amount (per month, per year, worst drop); also shown in `golive` and after connecting Binance.
- **💬 Ask the bot (optional AI helper):** `ask …` or just type a question. Answers from the user's own data (positions, practice, auto-buy reasons, savings) in their language. It explains only — it never trades, picks coins or predicts prices. Needs `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- **Paid access (optional):** Paystack and Flutterwave, managed from the admin's 💳 Subscriptions panel — with **free access for small accounts** (Binance Spot balance up to $100 by default; savings-plan coins don't count).

## Setup

> Deploying from GitHub Codespaces? See **`DEPLOY.md`** (drag the folder in, run two scripts, push).

1. Deploy to Vercel. Add the variables from `.env.example`, at least `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET` and the two `UPSTASH_*` values.
2. Open `https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET` once. This registers the command menu **and** the webhook with its secret token.
3. Optionally, open `/api/health?key=YOUR_CRON_SECRET` to check the setup.
4. Point your cron jobs (for example cron-job.org) at the endpoints below and **add `?key=YOUR_CRON_SECRET`** to each URL.

## Endpoints

| Endpoint | Schedule | Key needed | What it does |
|---|---|---|---|
| `/api/v2quickcheck` | every 10 min | yes | Price-only check of targets and stops |
| `/api/v2monitor` | every 30 min | yes | Full position check: TPs, milestones, 4h HOLD |
| `/api/v2scan` | every 30–60 min | for alerts | Scanner. Without the key it returns data only |
| `/api/v2listings` | optional | for alerts | Listing scanner. Without the key it returns data only |
| `/api/v2listings-alert` | every 30 min | yes | Broadcasts moonshots, listings and trending coins |
| `/api/v2moonshot` | every 30 min | yes | Sends high-score moonshots to the admin |
| `/api/v2advice?symbol=SOLUSDT&buyPrice=150&account=1000&risk=1` | – | no | Exit advice for one position (read-only) |
| `/api/backtest` | – | no | Saved backtest results of the live strategy (`data/strategy-stats.json`) |
| `/api/health` | optional (uptime monitor) | yes | Checks every data source, Upstash and Telegram from Vercel |
| `/api/set-commands` | once | always | Registers the bot menu and webhook |
| `/api/telegram-webhook` | – | Telegram secret header | Bot updates |

"Key" means `?key=CRON_SECRET` or the header `Authorization: Bearer CRON_SECRET`.
If `CRON_SECRET` is not set, endpoints stay open (with a warning in the logs) so an existing deployment keeps working. **Set it.**

## Telegram commands

`buy SOL 92.50 [qty] [2x|10%] [sl 88] [ex mexc]` · `setstop SOL 90` · `sell SOL` · `sold SOL 92.50 110 [qty]` (records the trade for `profit`) · `positions` · `check SOL` · `profit` · `split 50` · `scan` · `newlistings` · `menu` · `help`

Practice (play money, real prices): `practice` · `practice buy SOL 100 [2x] [sl 140]` · `practice sell SOL` · `practice reset`

Go live (guided Binance set-up): `golive` · `balance` (your Binance Spot wallet) · `expect 50` (what to expect for an amount)

Weekly savings: `save 10` · `save 5 btc` · `save day monday` · `save real` / `save practice` · `save now` · `save pause` / `resume` · `save stop`

Auto-buy: `autobuy` · `stops` (today's signals) · `autobuy on|off` (practice) · `autobuy live on|off` (locked until proven) · admin: `autobuy run|pause|resume|unlock|lock` · research: `npm run lab`

Automated exits (optional, Binance): `autotrade` · `autotrade connect KEY SECRET` · `autotrade on` · `autotrade off` · `autotrade disconnect` · `autotrade resume SOL`

Paid access (when PAID_ACCESS_ENABLED=true): `account` · `subscribe you@example.com` · `subscribe check`

Admin: `pending` · `users` · `approve ID` · `block ID` · `remove ID` · `invite` · `subs` · `subs free 100` / `subs free off` · `grant ID DAYS` · `revoke ID`

## Local use

```bash
npm install
cp .env.example .env    # fill in
npm start               # one scan of BINANCE_SYMBOLS (same engine as /api/v2scan)
npm run scheduler       # repeat on CRON_SCHEDULE
npm run backtest        # backtests the LIVE strategy (needs Binance access) → commit data/strategy-stats.json
npm run research        # tests 48 strategy variants, chooses on 8 months, judges on 4 unseen months
npm test                # offline unit tests
```

## Code layout

```
api/                  Vercel functions (one per endpoint)
src/lib/              Shared building blocks: telegram, redis, market data, auth
src/services/         scanEngine (live strategy), strategyBacktest + strategyStats,
                      adviceService, positionStore, userService, profitTracker,
                      listings/probability, risk, portfolioService (dashboard),
                      tradingAccounts + autoTrader (automated exits),
                      subscriptionService (paid access, Paystack),
                      practiceService (play-money practice mode),
                      autoBuyer + strategyLab + src/strategies (auto-buy),
                      savingsPlan (weekly savings), expectations (what to expect),
                      aiHelper (💬 Ask the bot)
data/                 strategy-stats.json (saved backtest summary, shown in alerts)
public/               Landing page + dashboard
test/                 node:test suite (no network)
```

## Vercel Hobby limit

The free Hobby plan allows **12 functions** per deployment, and each file in `api/` counts as one. There are 12 now (the maximum); new features are added as actions in `api/app.js`. Before adding a new endpoint, merge or remove one, or the deployment will fail.

## Known limitations (not changed in this upgrade)

- The moonshot / listings score (0–92) can't be backtested (no free history for its inputs). It is labelled as a heuristic everywhere.
- Backtest results depend on the period tested; re-run `npm run backtest` regularly.
- Binance blocks some server regions (including Vercel's default US region). Candles and prices fall back to Kraken/KuCoin, but `/api/v2listings` is Binance-only.
- Moonshot scans make many CoinGecko calls, and the free tier may rate-limit them.
- Functions are limited to 60 seconds; very long coin lists in `BINANCE_SYMBOLS` may need splitting.
- The original signal scanner was tested and shown to have no edge after fees; its alert crons stay off. The auto-buy strategy passed its lab test but is still in its live forward test (see `STRATEGY.md`).

See `CHANGELOG.md` for what changed, and `STRATEGY.md` for how the strategy is tested.
