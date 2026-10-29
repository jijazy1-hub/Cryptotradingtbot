# Setup for crptotradingbot.vercel.app (@JijazyBot)

Your real secret values are in **PRIVATE-vercel-secrets.txt**. That file is kept on your device and never uploaded to GitHub.
Wherever this guide says `YOUR_CRON_SECRET`, use the `CRON_SECRET` value from that file.

## 1. Vercel → crptotradingbot → Settings → Environment Variables

Add:
- `CRON_SECRET`: from the private file
- `TELEGRAM_WEBHOOK_SECRET`: from the private file
- `BOT_USERNAME` = `JijazyBot`
- `PUBLIC_BASE_URL` = `https://crptotradingbot.vercel.app`

Optional — automated exits (2.8.0):
- `TRADING_ENCRYPTION_KEY`: 64 hex characters that encrypt users' Binance keys. Make one with `openssl rand -hex 32` (or see the private file). Without it, automated exits are simply unavailable. **Never change it later** — saved keys could no longer be read, and users would have to connect again.
- `AUTOTRADE_DRY_RUN` = `true` to try it without placing any orders (remove it to go live).

Check these already exist (they were never in the code):
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and optionally `TELEGRAM_INFO_CHANNEL_ID`.

Then go to **Deployments → latest → ⋯ → Redeploy**.

## 2. Register the webhook (once)

https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET  → expect `"secretTokenRegistered": true`
https://crptotradingbot.vercel.app/api/health?key=YOUR_CRON_SECRET → health check

## 3. cron-job.org

| Job | Every | URL |
|---|---|---|
| Quick check | 10 min | `https://crptotradingbot.vercel.app/api/v2quickcheck?key=YOUR_CRON_SECRET` |
| Monitor | 30 min | `https://crptotradingbot.vercel.app/api/v2monitor?key=YOUR_CRON_SECRET` |
| Scanner | 30–60 min | `https://crptotradingbot.vercel.app/api/v2scan?key=YOUR_CRON_SECRET` |
| Listings alert | 30 min | `https://crptotradingbot.vercel.app/api/v2listings-alert?key=YOUR_CRON_SECRET` |
| Moonshots | 30 min | `https://crptotradingbot.vercel.app/api/v2moonshot?key=YOUR_CRON_SECRET` |

The dashboard stays public at https://crptotradingbot.vercel.app/dashboard

## 4. Backtest the strategy (once, then monthly)

On your computer, inside the project folder:
```bash
npm install
npm run backtest
git add data/strategy-stats.json
git commit -m "Backtest results"
git push
```
BUY alerts and the dashboard's Track Record tab will then show the measured results. See `STRATEGY.md`.

## 5. Test

Send `/start` to @JijazyBot. Then try `buy SOL 150 2x` → `positions` → `sold SOL 150 160` → `profit`.

## 6. Automated exits (optional)

1. Add `TRADING_ENCRYPTION_KEY` (above) and redeploy. `/api/health` should show `"autoExits": {"available": true}`.
2. Go to https://testnet.binance.vision, log in with GitHub, and click **Generate HMAC_SHA256 Key**. Testnet accounts come with fake balances.
3. In Telegram: `autotrade connect API_KEY API_SECRET`, then `autotrade on`.
4. Add a position with a quantity, for a coin you hold on the testnet: `buy BTC 65000 0.01`. The bot replies "Stop placed on Binance (testnet)".
5. Real money: Binance only allows trading on keys locked to fixed IPs, and Vercel has none, so set up the fixed-IP proxy first (step 8). Then users follow `golive`.

## 7. Paid access (optional)

Everything is done in the bot: **📋 MENU → 💳 Subscriptions** (admin only), or send `subs`.
- **Paid access ON/OFF:** one button. Before switching on, it tells you how many users have no subscription and offers to give them 7 days first.
- **💵 Plan & price:** price, length (1 week / 1 month / 3 months, or `subs days N`) and currency (NGN, GHS, ZAR, KES, USD).
- **🎁 Give a subscription:** pick a user, then 1 week, 1 month, 3 months, 6 months, 1 year, or **📅 Until a date I choose** (type e.g. `31/12/2026`; access ends at midnight Lagos time). Or type `grant ID 31/12/2026` / `grant ID 30`.
- **⛔ End a subscription** and **👥 List subscribers**.

For users to pay by themselves, set up **Flutterwave** and/or **Paystack**. With both, users choose; with one, it's used automatically.

**Flutterwave:**
1. Flutterwave dashboard → Settings → **API Keys**: copy the **Secret key** (`FLWSECK_TEST-…` for test mode).
2. Settings → **Webhooks**: URL `https://crptotradingbot.vercel.app/flutterwave-webhook`, and type a **Secret hash** (any long random text).
3. Vercel → Environment Variables: `FLW_SECRET_KEY` = the secret key, `FLW_SECRET_HASH` = the same secret hash. Redeploy.
4. Test from a non-admin account with a Flutterwave test card, then switch to your live key (`FLWSECK-…`).

**Paystack:**
1. Paystack → Settings → API Keys & Webhooks: copy the **Secret key** (`sk_test_…` to try with test cards) and set the **Webhook URL** to `https://crptotradingbot.vercel.app/paystack-webhook`.
2. Vercel → Environment Variables: `PAYSTACK_SECRET_KEY` = your secret key. Redeploy.
3. Test from a non-admin account: `subscribe you@example.com` → pay with a test card → back in Telegram with "Payment received". Then switch to your `sk_live_…` key.

(The old `PAID_ACCESS_ENABLED` / `SUBSCRIPTION_*` Vercel variables still work as defaults, but the panel's settings take priority.)

**Free for small accounts:** with paid access on, users whose Binance Spot balance is $100 or less use the bot free (coins bought by their weekly savings plan don't count). Change the limit in 💳 Subscriptions → 🆓 Free for small accounts, or `subs free 150` / `subs free off`. Optional Vercel default: `FREE_ACCOUNT_LIMIT_USD`.

## 8. Fixed IP for real Binance trading (Fixie)

Binance deletes trading keys that aren't locked to specific IP addresses. Vercel's addresses change, so the bot sends its Binance account and order requests through Fixie, which has two fixed IPs. Prices and charts don't go through it.

1. Sign up at https://usefixie.com and create a proxy (EU region if offered; the free plan is enough for testing).
2. Vercel → Environment Variables:
   - `FIXIE_URL` = the proxy URL Fixie shows (`http://fixie:…@….usefixie.com:80`)
   - `TRADING_IPS` = Fixie's two outbound IPs, comma-separated, e.g. `54.1.2.3,54.4.5.6`
3. Redeploy. `/api/health` shows `"fixedIpProxy": true` and the IPs. Step 3 of `golive` now tells every user to restrict their key to exactly these IPs.

About 1,500 proxy requests per open live position per month. Upgrade the Fixie plan as live users grow.

## 9. Auto-buy

- `npm run lab` (in the Codespace) tests 22 strategy variants on ~4 years of daily data and writes `data/auto-strategy.json`. Commit it.
- Practice auto-buy works straight away for anyone (`autobuy on`). The bot's own "house" practice account always runs it. That's the forward test.
- Live auto-buy stays locked until the lab gives a PASS **and** the house account has run 8+ weeks with 20+ closed trades in profit. Then `autobuy unlock` (admin), and each user opts in with `autobuy live on`.
- Kill switch: `autobuy pause` / `autobuy resume`. Test run: `autobuy run`.

## Optional: 💬 Ask the bot (AI helper)

Users can ask questions in plain words ("why did the bot buy SOL?", "how do I move USDT to Spot?") and get answers based on their own positions, practice, auto-buy reasons and savings plan. The AI **only explains** — it never buys or sells, never picks coins and never predicts prices. Trading decisions stay with the tested strategy.

1. Get an API key: OpenAI (platform.openai.com → API keys) or Anthropic (console.anthropic.com → API keys). Add some credit; a question costs a fraction of a cent.
2. In Vercel → Settings → Environment Variables add `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`). Optional: `AI_MODEL` (default `gpt-4.1-mini` / `claude-haiku-5-5` — check your provider's current model names), `AI_DAILY_LIMIT` (default 20 questions per user per day; you have no limit).
3. Redeploy. `/api/health` shows `aiHelper.on: true`. Tap 💬 Ask the Bot, or just type a question.

Without a key the button says the helper isn't switched on, and nothing else changes.
