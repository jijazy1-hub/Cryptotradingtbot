# Changelog

## 2.23.0 — Every Binance coin, and trades are closed daily

**What changed**

- **One strategy on every liquid Binance coin.** The daily auto-buy no longer looks at a fixed list of 15. It takes every Binance USDT spot coin that is trading, drops stablecoins and coins that traded less than $1M in 24h, and applies the *same* rule to all of them (`src/services/universe.js`). Coins are checked most-traded first; when more coins signal than the 5-position limit allows, the most-traded ones are bought first. Settings: `AUTOBUY_UNIVERSE` (`ALL` or a list like `BTC,ETH`), `AUTOBUY_MIN_VOLUME_USD`, `AUTOBUY_MAX_COINS`. If Binance's coin list can't be fetched, the 15 core coins are used and the admin report says so.
- **Daily close.** At each daily run (00:05 UTC or later) every auto-bought position is sold, then today's signals are bought. Practice and the house account sell at the live price; live accounts have the Binance stop order cancelled first, then a market sell, then the trade is saved to history (`autoTrader.closeNow`; if anything fails after the stop was cancelled, the stop is put back). ⚡ Buy Now positions are the user's own pick and are left alone. Switch off with `AUTOBUY_DAILY_CLOSE=false` (back to holding until the trailing stop).
- **`stops` / dashboard / manual** now describe all-coins mode; `stops` shows buy signals first, then the coins closest to one (Telegram message limit).
- **`npm run lab -- --all --top 100`** tests the strategy on the most-traded Binance coins instead of the 15 core coins.
- **Safety net:** `vercel.json` has a daily cron on `/api/v2monitor` (00:05 UTC) so the daily run happens even if the external cron is down (Vercel Hobby may run it up to an hour late).
- **Deploy scripts** for Codespaces → Vercel (`scripts/`, `DEPLOY.md`). `push-env-to-vercel.sh` only adds missing variables by default and never replaces `TRADING_ENCRYPTION_KEY`.
- Tests: 187.

**Honest note:** the saved lab result (`data/auto-strategy.json`, verdict PASS) was measured on 15 coins with trades held for weeks (average ~33 days). Closing every trade after one day and trading hundreds of coins are **not** what was tested. Each daily close pays ~0.3% in fees and slippage when a coin is sold and bought again. Watch the practice/house account before trusting real money with this version; the live gate (8 weeks, 20 trades, profit) still applies.

## 2.22.1 — User manual brought up to date

- **📚 The manual's test figures now come from the latest lab result** (`data/auto-strategy.json`), so they update every time you run `npm run lab` and commit. It said "about 23% over 3 years, BTC made 85%"; it now says, from the current result: 108 trades, about 22% over 2.9 years (about 7% a year, worst drop 4.2%), holding BTC 94% with far bigger drops.
- **New section "💳 Do I have to pay?"**: the price (or "free right now"), free access for small accounts and its limit, and that practice, `expect`, `golive` and `balance` always work. When the AI helper is on, it also explains 💬 Ask the bot and the daily question limit.
- **"How to start"** now points small accounts to `expect 20` and the weekly savings plan (`save 10`).
- Tests: 180.

## 2.22.0 — Fairer strategy comparisons in the lab, and 💬 Ask the bot

**Auto-buy is unchanged** (practice, the house forward test and real money): the lab still picks the strategy on the training period only, `data/auto-strategy.json` keeps the same pick, and the bot trades exactly as before.

- **Strategy lab comparisons** (`npm run lab -- --days 3000`), shown after the main table and saved as `comparisons` — for information only, they never change the pick:
  - every strategy at **2% risk** per trade next to 1%;
  - **Breakout + Strongest coins together** in one account (a coin bought by both on the same day counts once): trades, average R, profit factor, verdict, and the 1% / 2% portfolio;
  - **holding BTC** and **holding BTC only while it's above its 200-day average** (costs on every switch), with the worst drop and the time in the market.
  - A better number here is a reason to test further, not proof — they're compared on the period they're judged on.
- **💬 Ask the bot** (optional AI helper): `ask what is a stop-loss?`, the 💬 Ask the Bot button, or just type a question (anything that isn't a command and has a "?" or 3+ words). Follow-up questions within 10 minutes need no "ask".
  - Answers use the user's own data: real positions (with why each was bought), recent sales, practice account, auto-buy status and the last check's reasons, Binance connection, savings plan. Only that user's data; never keys.
  - Strict rules: it explains and teaches; it never tells anyone to buy, sell or hold a coin, never predicts prices, never promises returns, never invents numbers, and says honestly that 50–100% a month isn't possible. It replies in the user's language (English, Pidgin, Yoruba, Hausa, Igbo).
  - Works with OpenAI (`OPENAI_API_KEY`, default model `gpt-4.1-mini`; GPT-5 models supported via `AI_MODEL`) or Anthropic (`ANTHROPIC_API_KEY`, default `claude-haiku-5-5`). 20 questions per user per day (`AI_DAILY_LIMIT`); the admin has no limit.
  - Answers are sent as plain text with a note: "AI answer: it can make mistakes, and it's not financial advice."
  - Something that looks like an API key is never sent to the AI.
  - Without a key nothing changes; the button explains it isn't switched on (and tells the admin how).
  - `/api/health` shows `aiHelper` (on/off, provider, model).
- Tests: 179.

## 2.21.0 — Weekly savings, free access for small accounts, what to expect

- **🐷 Weekly savings plan** (`save`, menu button 🐷 Savings Plan). For small accounts, adding money every week grows them far more than any strategy can.
  - `save 10` — every week on your day (default: today's weekday; `save day monday`), at 9am Lagos time, the bot buys $10 of crypto: $5 BTC + $5 ETH ($5 a week buys BTC only). Choose coins with `save 20 btc eth` (BTC, ETH, BNB, SOL). Minimum $5 per coin — Binance's own minimum.
  - **💰 Real:** buys on your own Binance account with the USDT in your Spot wallet (auto-trading must be on). The day before, if the USDT isn't there yet, you get a reminder. If it still isn't there at 9am, the bot says so once and tries again every 30 minutes; after 6 days that week is skipped.
  - **🎮 Practice:** the same plan with play money (`save practice`), new pretend money each week, separate from the $10,000 practice account. New plans start in practice unless auto-trading is already on.
  - **The bot never sells savings:** no stop orders, no take-profits, and they never show up as positions. Each buy message shows the total put in, what it's worth now and the next buy date.
  - `save now` makes an extra buy now (real money asks to confirm first) without changing the schedule; if this week's buy is waiting for USDT, it counts as that one. `save pause` / `resume` / `stop` (stop asks first and never sells anything).
  - Auto-buy leaves alone the USDT that a real savings buy due within a day will need.
  - Runs from the 30-minute monitor; each week's buy is placed once at most, even across retries.
- **🆓 Free access for small accounts.** With paid access on, users whose Binance Spot balance is at or under a limit (default **$100**) use the bot for free. Coins bought by their savings plan don't count, so saving never pushes anyone over.
  - Checked when they connect Binance, open `balance` or `account`, when they hit the "you need a subscription" screen (so access opens straight away), and once a day for everyone. A check older than 3 days no longer counts.
  - Someone who grows above the limit is told once and asked to subscribe.
  - Without a subscription, users can now still use `golive`, `balance` and `expect`, so they can connect and qualify. Turning on auto-trading still needs access.
  - Admin: 💳 Subscriptions → **🆓 Free for small accounts** ($50 / $100 / $200 / $500 / off), or `subs free 150` / `subs free off`. Optional Vercel default `FREE_ACCOUNT_LIMIT_USD`.
  - `account` shows "🆓 Free — small account" with the balance; `balance` says whether the account is under the limit.
- **📏 What to expect for your amount** (`expect 50`, menu button 📏 What to Expect):
  - turns the strategy's honest lab result (the 1%-risk portfolio on the unseen period, from `data/auto-strategy.json`) into dollars for any amount: on average per month and per year, the worst drop in the test, how often it buys, and holding BTC for comparison. With today's result: about 7% a year — $20 → about $0.11 a month.
  - says plainly when an amount is too small for auto-buy (under about $50) and suggests the savings plan.
  - **`golive`** now shows a short table ($20 / $50 / $100 / $500 / $1,000) and buttons for "What to expect for my amount" and "Save weekly instead". After connecting Binance, the bot shows the estimate for the user's real balance.
- **Manual:** a new section on weekly savings, and two new questions ("smallest amount", "Can I make $10–$20 a month from $20?" — honestly: no).
- The "subscription ended" screen now says "You need a subscription" to users who never had one, and mentions free access for small accounts.
- `save now` ignores a second tap within 2 minutes, so a double tap never buys twice.
- Tests: 172.

## 2.20.3 — Scan and moonshots look at Binance coins

- **🔍 Scan, 🌕 Moonshots and 💼 Split now scan Binance coins.** Before, they only looked at KuCoin, so many picks couldn't be bought on Binance (where Buy Now and auto-trading work). Now:
  - the coin list is every live Binance USDT pair that is up today with at least $200k of volume, minus big established coins, stablecoins, fiat, gold and wrapped tokens, and delisted pairs; the 30 busiest are scored;
  - the momentum check uses Binance's own hourly candles;
  - each pick shows "🏦 Exchange: Binance (COIN/USDT)", a ready `buynow COIN 10` (real money, high risk) and `practice buynow COIN 100`, and its track command includes `ex binance`.
  - If Binance can't be reached, the scan falls back to KuCoin and says so ("these come from KuCoin and may not be on Binance").
- The admin's moonshot alerts and the info-channel broadcast use the same Binance list.
- `/api/health` `moonshotData` now checks Binance (or KuCoin) plus CoinGecko.
- 🚀 New Listings is unchanged.
- Tests: 158.

## 2.20.2 — Fix: the daily auto-buy check crashed on BTC's price

- **Fixed: "Auto-buy check failed: maximumFractionDigits value is out of range".** The price wording added in 2.20.0 crashed on any price of $1,000 or more, so the check failed every time at "BTC $… is above its 100-day average", and nothing was bought for anyone (practice, house or real). The same crash also broke `stops` and ⚡ Buy Now. Prices from $1,000 now show in whole dollars ($104,250).
- The BTC market-filter wording can no longer stop the check, even if formatting ever fails again.
- A failed `autobuy run` now says "your `autobuy run`… Send `autobuy run` to try again" instead of "try admin run of 6… No more tries today".
- New tests use real-world prices (BTC around $100,000, ETH around $3,000). Tests: 155.

## 2.20.1 — An up-to-date user manual

- **📚 User Manual rewritten** (`manual` / the menu button). It still said "the bot is read-only — you execute all trades", called itself CryptoBot V2 and presented the switched-off signal scanner as the main feature. It now explains, in 9 short sections:
  - what JijazyBot does (track and alert on 7 exchanges, practice with play money, buy and sell on your own Binance account);
  - how your money stays safe (your own Binance account, no withdrawals, encrypted keys, `golive off`);
  - how to start (practice and `autobuy on` first, then the 4-step `golive`);
  - how the bot buys (Buy Now, auto-buy, the 55-day breakout with the BTC filter, the safety limits, the rising stop);
  - what to expect, honestly (about 3 buys a month, more than half of trades lose a little, +23% vs BTC's +85% in the test);
  - logging your own trades, the alerts (TP1 40% · TP2 35% · TP3 the rest, done automatically for bot-managed positions), the high-risk scans;
  - common questions: "Does the bot buy/sell for me?" → "Only if you ask it to…", "Why hasn't auto-buy bought anything?", "Why is my balance $0?", the $5 minimum.
- **`autobuy on` now says where today stands:** whether today's check has already run and what it found (signals, or BTC below its 100-day average), and when your first check is. If today's check already bought a coin for others, it tells you how to buy it now in practice (`practice buynow COIN 500`).
- Tests: 152.

## 2.20.0 — Back buttons, reasons for every auto-buy, safer payments

- **⬅️ Back on every screen, and old screens disappear.** Tapping any button now removes the message it was on (and the rest of that screen), and the next screen has a ⬅️ Back button that returns to the screen you came from: menu → Practice → Auto-buy → Today's stops → Back → Auto-buy → Back → Practice → Back → menu.
  - Back only ever shows a screen again. It never repeats an action: after "Yes, buy $50 of SOL" or "Start again with $10,000", Back goes to the screen you started from without buying or resetting twice.
  - Receipts are kept: results such as "✅ Bought…" or "🟢 Auto-trading is ON" get a Back button but stay in the chat.
  - Typed commands work as before; their screens with buttons get ⬅️ Back to the menu.
  - The bot remembers screens for 7 days (`cryptobot:nav:*` in storage). Nothing typed is stored except known screen names, so API keys can never end up there.
- **Every auto-buy explains itself** (practice, the house forward test and real money):
  - the signal in numbers ("closed at $182.41, above its 55-day high of $179.80, +1.5%"),
  - the market filter ("BTC $104,250 is above its 100-day average $97,830"),
  - the strategy's test result in plain words,
  - why that amount ("if the stop is hit you lose about $100 — 1% of your account"; says so when the 20% cap or the cash limited it),
  - how it will sell.

  The reason is also saved on the position (`buyReason`).
- **A note on days with nothing to buy,** for everyone who switched auto-buy on: "No coin to buy today", with why (BTC below its 100-day average, or the 3 coins closest to a breakout and how far each still has to rise). Once a day.
- **Daily report for the admin:** the market filter, every buy signal with its reason, what each account bought (🏠 house, 🎮 practice, 💰 real) and how many accounts were checked. The house account's buys are also sent to the admin in full.
- **Fixed: a failed daily check no longer loses the day.** Before, the day was marked "done" before the prices were fetched, so a Binance hiccup or a timeout meant no buying until the next day. Now the day only counts once the check succeeds. The next monitor run (30 minutes later) retries, up to 6 times, and the admin is told about each failure. Each account is still handled only once a day, even across retries.
- **Fixed: the strategy fallback.** If `data/auto-strategy.json` is ever missing, the bot now uses the settings that passed the lab test (breakout 55/20 with the BTC filter) instead of an untested 20/10 variant. It still shows "NOT TESTED" (so live auto-buy can't be unlocked on it), and `/api/health` (`autoBuyStrategy.warning`) and the admin's daily report warn about it.
- **Fixed: Paystack webhooks without a valid signature are refused** (HTTP 401) before anything else, so nobody can make the bot call Paystack with fake events. The signature is checked on the raw body when available, otherwise as Paystack's own docs do it. Payments still only count after Paystack's verify API confirms them, and the `/paid` return link and `subscribe check` still credit payers on their own.
- **Up-to-date descriptions:** the README, `package.json`, the welcome message, the go-live intro, practice help, the auto-exits screens and the dashboard no longer say the bot "never buys" or that "the strategy lost money". They now describe Buy Now, auto-buy and the tested breakout strategy (with its honest caveats).
- The auto-buy screen shows the last check's reasons and the BTC filter.
- Tests: 150.

## 2.19.0 — Flutterwave payments

- **Flutterwave** added next to Paystack (Standard checkout, v3 API): cards, bank transfer and USSD.
  - If both are set up, `subscribe` asks "How would you like to pay?" with 💳 Pay with Flutterwave / 💳 Pay with Paystack. If only one is set up, the bot goes straight to it. The email is asked once and reused.
  - The same safety rules apply: a payment only counts after **Flutterwave's verify API** confirms it was successful, for the right amount (in naira) and currency, for a payment link this bot made for that user. Each payment is credited once, even if the return link, the webhook and `subscribe check` all arrive.
  - Webhook at `/flutterwave-webhook`. If `FLW_SECRET_HASH` is set, requests without the matching `verif-hash` header are ignored.
  - The return link `/paid` works for both providers.
- The admin panel shows which payment providers are set up.
- New Vercel variables: `FLW_SECRET_KEY`, `FLW_SECRET_HASH` (see SETUP.md step 7).
- Tests: 141.

## 2.18.0 — Subscriptions panel for the admin

- **💳 Subscriptions** (admin menu button, or `subs`). Everything is in the bot, with no Vercel variables needed:
  - **Paid access ON/OFF** with one button. Before switching on, it shows how many approved users have no subscription and offers "🎁 Give them 7 days, then turn on". It also warns if Paystack isn't set up yet.
  - **Plan & price:** set the price (type it), length (1 week / 1 month / 3 months, or `subs days N`) and currency (NGN, GHS, ZAR, KES, USD).
  - **Give a subscription:** choose a user, then 1 week / 1 month / 3 months / 6 months / 1 year, or **📅 until a date you choose**. Dates are accepted as 31/12/2026, 2026-12-31 or 31 Dec 2026, and access ends at midnight Lagos time. Impossible dates (31/02) are refused. The user is told "You've been given access until …".
  - **End a subscription** (immediately) and **List subscribers** (with end dates).
- `grant ID 31/12/2026` now works as well as `grant ID 30`.
- Settings are stored in the database. The old Vercel variables are only defaults.
- Tests: 139.

## 2.17.1 — Catch "buy PEPE 50" mistakes

- `buy COIN PRICE` logs a buy you already made, where PRICE is per coin. If the price is more than 2× away from the market (e.g. `buy PEPE 50` when PEPE is $0.0000098), the bot now stops and asks. It explains the difference and offers buttons:
  - ✅ Yes — I bought at $50 each (an old buy);
  - ⚡ Buy $50 of PEPE now (real money);
  - 🎮 Practice: buy $50 of PEPE.
- Dashboard "Add position": same check, with a confirm prompt. The field is renamed "Price you paid per coin ($)".
- The Log a Buy guide now says PRICE is per coin and points to Buy Now for spending money.

## 2.17.0 — Today's stop for every coin

- New `stops` command, and a 🛡 Today's Stops (all coins) button in the menu and on the `autobuy` screen. For each of the 15 coins it shows yesterday's close, where the stop would be, and how far below that is, with ✅ for coins that have a buy signal today. If the BTC market filter is off, it says so.
- Stops are recalculated every day from each coin's recent prices. The rule for the current strategy is the lower of the 20-day low and 2× the coin's average daily range. Once a coin is bought, its stop only moves up.

## 2.16.1 — $5 minimum (Binance's own)

- The bot's minimum order is now **$5**, the same as Binance's Spot minimum for most USDT pairs. It was $10. Practice mode uses the same $5, so it behaves like real trading. Some coins need more on Binance, and that rule is still checked.
- What this means in practice:
  - **Buy Now:** a $25 account can buy $5 of a coin (20% per coin).
  - **Auto-buy:** sizes each trade so about 1% of the account is at risk. With a typical ~10% stop, that's a $5 buy from a **$50** account.

## 2.16.0 — Real and practice clearly separated

- **`positions` shows REAL money only**, titled "💰 REAL MONEY — your positions", in two groups:
  - 🤖 **Managed by the bot on your Binance account** (the bot sells these for you), with each one's stop and whether its stop order is on Binance;
  - 📝 **Tracked only — you sell these yourself** (alerts only).

  A separate button underneath: "🎮 See my PRACTICE positions (3)".
- **Practice is always labelled as play money:** "🎮 PRACTICE — play money, not real", "🎮 PRACTICE buy (play money)", "🎮 PRACTICE · SOL TP1…", "🎮 Practice cash (play money)".
- **Every message about your Binance account starts with 💰 REAL:** stop placed or moved, sold, closed, auto-bought.
- The end-of-day result lists "💰 REAL money" and "🎮 PRACTICE (play money)" on separate lines.
- Menu: "💰 Real Positions" and "🎮 Practice (play money)". Dashboard tabs: "💰 Real Portfolio" and "🎮 Practice (play money)".
- Real and practice were already stored separately; this makes the difference obvious on screen.
- Tests: 134.

## 2.15.0 — Buy Now, and an end-of-day result

- **⚡ Buy Now:** `buynow SOL 50` (real money) or `practice buynow SOL 50` (play money), plus a menu button.
  - Before buying, the bot checks the coin against the strategy and says so plainly: "✅ The strategy agrees: SOL has a buy signal today", or "⚠️ The strategy wouldn't buy ADA today — no buy signal… this trade isn't backed by the test results".
  - The user confirms with a button. The bot buys at market, puts a stop order on Binance straight away, and manages the trade with the strategy's trailing stop. The stop moves up as the price rises, and the bot sells when it's hit.
  - Limits: at most 20% of the account in one coin, only the USDT actually in the Spot wallet, and coins on Binance with enough price history. Real money needs auto-trading on. It works even before auto-buy is opened, because the user chooses the coin.
- **End-of-day result** (sent just after the daily close, about 1am Lagos time) to everyone who closed trades that day, real and practice:
  - **Profit:** congratulations, and the bot keeps watching.
  - **Loss:** an apology ("I'm sorry — today ended at a loss"), a plain explanation that losing days are normal for this strategy (more than half of trades lose a little; fewer, bigger winners make up for them), encouragement that the plan carries on tomorrow, and a reminder that `golive off` pauses at any time.
  - Sent once per day. An admin `autobuy run` never repeats it.
- Trailing stops now update daily for every strategy-managed position, including Buy Now buys and practice positions, not just auto-buy users.
- Menu: ⚡ Buy Now added; "Add a Buy" renamed "📝 Log a Buy" (recording a buy you made yourself).
- Tests: 133.

## 2.14.0 — A menu with everything

- **📋 MENU now has a button for every feature,** grouped:
  - **Your trades:** My Positions · Add a Buy · Record a Sale · Stop Tracking · Change a Stop · Check a Coin · My Profits · Split Capital
  - **Automation:** Auto-trading · Auto-buy · Binance Balance · Practice
  - **Market:** Scan Now · Moonshots · New Listings · My Dashboard
  - **Account:** My Account · All Commands · User Manual
  - **Admin (only you see these):** Pending · Users · Subscribers · Invite Links
- "Check a Coin" shows your own coins as buttons, so there's nothing to type. "Change a Stop" explains `setstop`.
- `help` is rewritten as "All commands", grouped the same way, with an admin section only you see.
- The menu message is still removed after you tap one of its buttons.
- Tests: 129.

## 2.13.0 — Auto-trading button, daily profit, tidier chat, readable dashboard

- **One button after connecting Binance: "🤖 Turn on auto-trading".** It turns on selling (stop orders, take-profits, trailing stops) **and** buying (the daily auto-buy), once the admin has opened buying. `golive off` turns both off and cancels the bot's stop orders. `golive` shows whether auto-trading is on, selling only, or off.
- **The admin can open live auto-buy before the forward test finishes** (`autobuy unlock`), for example to prove it on your own account first. It's recorded as "open early", and anyone switching it on sees exactly how far the forward test has got ("Not proven yet: 3 of 56 days…").
- **Today's profit after every closed trade:** auto-closed trades, `sold` records and practice trades now end with "📅 Today so far: 3 closed trades · 2 won · +$14.20".
- **The menu message disappears** when one of its buttons is tapped, so the chat doesn't fill up with old menus. Other messages with buttons are kept.
- **Dashboard easier to read:**
  - a clean sans-serif font (Inter) instead of monospace everywhere;
  - text sizes raised (nothing below 12px);
  - labels and secondary text with much higher contrast, from about 2:1 to 6:1+;
  - tiny prices shown in full (0.0000098, no "…") and big prices with 2 decimals;
  - a quieter background grid.

  The "Auto-exits" tab is now "Auto-trading".
- Tests: 128.

## 2.12.0 — Check your Binance balance in the bot

- New `balance` command and a 💰 My Binance balance button in the menu. They show the user's Spot wallet: total in USD, every coin worth $1 or more, and how much is held by open orders (e.g. the bot's stop orders).
- The dashboard's 🤖 Auto-exits tab shows the same balance table, with a refresh button.
- It reads through the fixed-IP proxy like every other account request (one request per check).

## 2.11.1 — Clearer IP step

- Go-live step 3 now lists each IP on its own line: "Paste IP 1 → tap Confirm, Paste IP 2 → tap Confirm". It says to add them one at a time (no commas), that every IP is needed, and to check they all show before ticking Spot trading.
- Connecting a real key now checks it 5 times through the fixed-IP proxy. A key missing one of the bot's IPs is refused with a plain explanation, instead of failing randomly later.
- Lab: a strategy that made a little money but not enough now says so, instead of "lost money".

## 2.11.0 — Auto-buy (practice now, live only after proven results)

- **The bot can choose and buy coins by itself.** Once a day just after the daily close (00:05 UTC), it checks the chosen strategy on 15 large coins (BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, DOT, LTC, TRX, NEAR, ATOM, UNI) and buys the ones that signal. Exits use a trailing stop that only moves up.
- **New strategy families**, different from the old one rather than tweaks of it: breakouts to new highs (Donchian), trend pullbacks (EMA trend), and the strongest coins (momentum rotation). Each is tested with and without a "BTC above its 100-day average" filter: 22 variants in all.
- **`npm run lab`** tests them honestly:
  - closed daily candles, buying at the next day's open;
  - 0.1% fee and 0.05% slippage on every buy and sell;
  - stops fill at the gap price when the price opens below them;
  - settings chosen on the older 65% of ~4 years and judged only on the newer 35%.

  Verdicts are PASS, PROMISING or FAIL. It also reports a 1%-risk portfolio return, maximum drawdown and BTC buy-and-hold over the same period. The result is saved to `data/auto-strategy.json`.
- **Practice auto-buy** (`autobuy on`, or the 🎮 Practice tab) runs with play money for anyone. Until the lab has run, it uses a labelled, untested default (20-day breakout).
- **House forward test:** a practice account the bot always runs. Its results, from today on, are the honest real-world check.
- **Live auto-buy is LOCKED.** The admin can only `autobuy unlock` once the lab says PASS **and** the house account has 8+ weeks, 20+ closed trades and a profit. Each user must then opt in (`autobuy live on`, with a confirm button) and have automated exits connected.
- **Safety limits on every account:** about 1% of the account at risk per trade, no coin above 20%, at most 5 auto positions, and no new buys after a 3% fall since the previous day. Admin kill switch: `autobuy pause`.
- **Fixed IP for real Binance trading:** set `FIXIE_URL` (and `TRADING_IPS`) in Vercel. Signed Binance requests then go through Fixie, and the go-live wizard tells users to lock their key to those IPs. This replaces the earlier "Unrestricted" advice, which Binance doesn't allow for trading keys.
- Monitor: auto-bought positions follow their trailing stop only, with no take-profits.
- Tests: 123.

## 2.10.0 — Practice mode and a guided "Go live"

- **🎮 Practice mode:** every user gets $10,000 of play money, with nothing to set up — no Binance account, no keys. `practice buy SOL 100`, or the new 🎮 Practice tab on the dashboard.
  - **Priced like a real Binance account:** live Binance prices, the 0.1% fee on every buy and sell, 0.05% slippage, and stops that act like real stop orders. A stop triggers if any 1-minute candle since the last check touched it, and fills lower if the price gapped past it.
  - **The same exit plan as live automated exits:** stop, then TP1 40% (stop → breakeven), TP2 35% (stop → TP1), TP3 the rest, and 60% at your own target. The bot handles exits every 10 minutes and messages you.
  - Separate from real positions and real history. `practice` shows total value, return since start, open trades and closed-trade stats. `practice sell SOL` sells now; `practice reset` starts again.
- **🚀 Go live wizard (`golive`, or the button in the menu):** 4 steps with buttons:
  1. Binance account and verification;
  2. buying USDT with Naira on P2P, including the Funding → Spot transfer;
  3. creating an API key with trading ON and withdrawals OFF;
  4. pasting the two codes.

  Each code is deleted from the chat as soon as it arrives, checked with Binance and stored encrypted. The bot shows the USDT balance, then turns automated exits on after a plain-language confirmation button (no phrase to type).
- Money always stays in the user's own Binance account. The bot never holds funds.
- **Security:** any message containing a long code is no longer written to the logs.
- Menu: new 🎮 Practice and 🚀 Go live buttons.
- Tests: 113.

## 2.9.0 — Paid access (optional, Paystack)

- **Off unless you set `PAID_ACCESS_ENABLED=true`.** Until then nothing changes.
- When it's on, approved users also need an active subscription to use the bot and dashboard and to get position alerts. **The admin never pays.** Approval still works as before.
- **Paying:** `subscribe you@example.com` (the email is for the Paystack receipt) → a 💳 Pay button → Paystack checkout (card, transfer, USSD) → back to Telegram, and access starts straight away. The dashboard shows a "Renew" card with the same flow.
- **Payments are only counted after Paystack's verify API confirms them**, with the right amount and currency, for a payment link this bot made for that user. Each payment is credited once, even if the webhook, the return link and `subscribe check` all arrive together.
- Renewing early adds the time on top of what's left.
- **Reminders** (sent by the 30-minute monitor): 3 days before the end, and once when it ends. When a subscription ends, position alerts pause. Stop orders already on Binance stay there.
- While a subscription has ended, users can still use `account`, `subscribe`, `help`, `sell`/`remove` (to close positions) and `autotrade off`/`disconnect`.
- Commands: `account`, `subscribe [email]`, `subscribe check`. Admin: `subs` (everyone's status), `grant ID DAYS` (free time), `revoke ID`.
- Settings: `SUBSCRIPTION_PRICE` (default 5000), `SUBSCRIPTION_CURRENCY` (default NGN), `SUBSCRIPTION_DAYS` (default 30).
- New links: `/paid` (where Paystack sends payers back) and `/paystack-webhook`. Both are actions inside `api/app.js`, so there are still 12 functions.
- **Fix:** the 10-minute quickcheck sent stop/target alerts to anyone with saved positions, including blocked or removed users. It now only checks approved users.
- `vercel.json` now includes `"regions": ["fra1"]` (which you'd added on your side) plus the two new links.
- Tests: 103.

## 2.8.0 — Automated exits (optional, Binance)

- **The bot can place your sell orders for you** on your own Binance account. It follows each position's locked plan:
  - a real **stop order on Binance** at your saved stop, so it works between bot checks;
  - **TP1** sells 40% of the quantity and moves the stop to breakeven; **TP2** sells 35% and moves it to TP1; **TP3** sells the rest;
  - **your own target** (2x, 25%…) sells 60% of what's left;
  - **stop hit** but the exchange stop didn't fill (price gapped through it) → the rest is sold at market;
  - when everything is sold, the trade is saved to your history and the position closes.
- **It never buys**, never opens positions, and only acts on Binance positions that have a quantity.
- **Off unless you turn it on.** New connections use the **Binance testnet** (fake money). Real money needs a key from binance.com plus the phrase `I UNDERSTAND REAL MONEY`.
- **Keys that can withdraw are refused.** Keys are checked with Binance, then stored encrypted (AES-256-GCM, `TRADING_ENCRYPTION_KEY`). The status never shows them, and the Telegram message containing them is deleted and never logged.
- **You stay in control:** `sell SOL`, `sold …`, or Remove on the dashboard cancel that position's stop order *without selling*. `setstop` moves the Binance order. `autotrade off` cancels all the bot's stop orders. A stop order cancelled outside the bot is re-placed once; if it happens again, that position is paused (`autotrade resume SOL`).
- Telegram: `autotrade` (status + set-up), `autotrade connect KEY SECRET`, `autotrade connect live KEY SECRET`, `autotrade on`, `autotrade off`, `autotrade disconnect`.
- Dashboard: new **🤖 Auto-exits** tab (connect, on/off, disconnect). Each position card shows its Binance stop order and what has been sold.
- Alerts for TP / stop / target say when the bot is handling the sale, so you don't sell twice.
- `AUTOTRADE_DRY_RUN=true` makes every order a no-op (the bot reads your balance but places nothing), to watch what it would do.
- `/api/health` shows `autoExits.available`.
- **Fix:** the 2.7.0 package contained an empty `package.json`. This package has the correct one.
- Tests: 96 (a fake Binance with balances and orders checks the whole plan).

## 2.7.0 — More coins & exchanges

- **Track coins on 7 exchanges:** Binance, Bybit, OKX, Gate, MEXC, KuCoin and Kraken. Previously, a coin not on Binance had no stop/TP plan and often no price.
  - **Auto-detect:** `buy XYZ 0.05` checks the exchanges in that order, uses the first that lists XYZ/USDT, and remembers it for 7 days.
  - **Choose:** `buy XYZ 0.05 ex mexc` (or `on gate`, `@okx`, or just `mexc`). The dashboard's "Add position" has an exchange picker.
  - The bot replies with "📍 Prices from: MEXC". `positions` and the dashboard show each position's exchange.
- **Each position uses only its own exchange** for alerts, advice, the dashboard and stop checks. There's deliberately no fallback to another exchange: the same ticker can be a different token elsewhere, and its price would trigger false stop or target alerts.
- **Monitor and quickcheck** fetch prices once per coin and exchange.
- **Unknown coins are refused** with a clear message, instead of being saved and never priced.
- **`/api/health`** now fetches a real BTC price and recent candles from every exchange, and checks that they agree. `exchangesWorking` lists which exchanges' data reads correctly.
- Positions added before this update have no exchange saved and keep working as before (Binance first).
- Tests: 84.


## 2.6.0 — Personal dashboard

- **My Portfolio tab:** each user sees their own real positions. It shows live price and P&L (% and $), the current stop and why it's there (plan / yours / breakeven / at TP1), the next take-profit, the target, and a bar showing where the price sits between stop and TP3. Totals: invested, value now, unrealised P&L, and positions needing action.
- **Actions on the dashboard:** add a position (with optional quantity, target and your own stop), change a stop, record a sale, remove a position. The rules are the same as the bot's: stops must be below the current price, and the trade plan is locked when you add.
- **History tab:** every closed trade, plus this month / last month / all-time P&L and win rate.
- **Login without passwords:** send `/dashboard` (or tap 🖥 My Dashboard in the menu) and the bot sends a private link that logs you in for 30 days.
  - The link is signed, so nobody can make one for another user.
  - The login code is removed from the address bar after opening.
  - `dashboard logout` signs out every device.
  - Blocked and pending users are refused.
- The old "My Positions" tab, which saved positions only in your browser, is replaced. Anything saved there is left untouched.
- **New `api/app.js`** handles all user actions. It's the 12th and last function allowed on Vercel Hobby, so future features become actions inside it.
- Small-price coins (e.g. PEPE) now show 4 significant digits instead of rounding to 0.000010. The layout works on phones (no sideways scrolling).
- Tests: 76.

### Do this after deploying
Open `/api/set-commands?key=…` once to add `/dashboard` to the bot menu, then send `/dashboard` to the bot.


## 2.5.0 — Reliability

### Do this after deploying
- **Nothing is required.** Existing users, positions and trades move to the new storage format automatically, the first time each is read. The old values are kept as `…-legacy-backup` keys in Upstash.
- Optional: open `/api/set-commands?key=…` once to add `/setstop` to the bot's menu, and `/api/health?key=…` to check every data source from Vercel.

### Saved data can no longer be overwritten
- **Positions:** one Redis hash per position, plus an index per user. Each update writes only the fields it changes. Before, every change rewrote a single JSON value holding all of a user's positions, so a buy made while the monitor was running, or a "stop hit" flag set by quickcheck at the same moment as the monitor, could silently disappear.
- **Trades:** an append-only list, so simultaneous `sold` records are all kept.
- **Users:** one hash field per user, so an approval and a new `/start` at the same moment both survive.
- **Duplicate-alert protection:** atomic claims (SET NX with expiry). Two scans running at once can't both send the same BUY alert, and a failed send releases the claim so the next run retries.
- **An update can't resurrect a position the user just removed.**

### Stops follow the plan
- After TP1, the saved stop moves to breakeven; after TP2, to TP1. The alerts already told users to do this, but the bot kept watching the original stop, so a return to entry after TP1 produced no alert. Now you get "🟡 BREAKEVEN STOP" or "🟢 PROFIT STOP".
- Stops only ever move up.
- **Your own stop:** `buy SOL 92.5 2x sl 88`; targets are then built from your stop.
- **Change it later:** `setstop SOL 90`, or `setstopid <entry id> 90` when you have several entries. A stop above the current price is refused.

### No more timeouts or duplicate replies
- **Telegram webhook** replies instantly and finishes slow commands (scan, newlistings, split) in the background, using `waitUntil` from `@vercel/functions`. Repeated deliveries of the same update are ignored.
- **Monitor** fetches market data once per coin instead of once per position, 4 coins in parallel. Quickcheck fetches prices 6 at a time. Overlapping runs of either are skipped.
- **Moonshot / listings scans:** one batch CoinGecko call replaces ~60 single calls. Contract addresses are fetched only for the coins shown, KuCoin calls run 5 at a time, and CoinGecko/KuCoin calls retry on rate limits (429) and server errors.
- `/api/v2listings` names all candidates in one call and fetches contract details only for BUYs.
- All functions may run up to 60 seconds (`vercel.json` → `maxDuration`).

### Data sources that work from Vercel
- Functions now run in **Frankfurt (`fra1`)**: closer to Nigeria, and api.binance.com doesn't block it (it blocks Vercel's default US region).
- `/api/v2listings` also falls back to the Binance public mirror.
- **New `/api/health?key=…`** checks Binance, the Binance mirror, Kraken, KuCoin, CoinGecko, Upstash and Telegram from the function's region, and returns 503 if something critical is down.

### Also included (from 2.4.0)
- `npm run research` and `src/config/strategy.js` (see `STRATEGY.md`).

- Tests: 70. Requires Node 20+ (Vercel's default).


## 2.3.0 — Honest strategy

### Do this after deploying
1. On your computer: `npm install`, then `npm run backtest`. This needs internet access to Binance and takes a few minutes. Add `-- --days 365` for more trades.
2. Commit and push the new `data/strategy-stats.json`. BUY alerts and the dashboard's Track Record tab then show the measured results.

### What changed
- **The backtest now tests the strategy the bot actually trades.** New `src/services/strategyBacktest.js` replays history through the live scanner's own `evaluateSignal()`, with the same candle windows. It trades the plan the BUY alert gives (TP1 40% → breakeven, TP2 35% → stop to TP1, TP3 25%), entering at the next candle's open.
- **Costs included:** 0.1% fee per fill, 0.05% slippage on market fills, the stop counted first when a candle touches both stop and target, and gaps filling at the open. All adjustable with `--fee`, `--slippage`, `--risk` and `--max-hold-hours`.
- **Honest statistics** (`src/services/strategyStats.js`): average profit per trade in R, win rate with a 95% range, profit factor, max drawdown, buy-and-hold comparison, results by setup score, warnings below 30 trades, and a plain-English verdict that says so when the strategy lost money.
- **No more made-up confidence:**
  - BUY alerts replace "Confidence 73% |███████░░░|" (which was just score ÷ 15) with the measured backtest line.
  - The dashboard shows "Setup score x/15" plus the track record.
  - Moonshot / scan / listings scores are labelled "heuristic, not backtested" everywhere, and the manual no longer promises "high-probability" or "2X–5X in 3 days".
- **Live signals no longer repaint.** The scanner ignores the still-forming candle, so a BUY can't appear and vanish within the same 15 minutes, and live signals match what was backtested.
- **Binance mirror fallback:** candles and prices also try `data-api.binance.vision` before Kraken. This helps Vercel's US servers, which `api.binance.com` blocks.
- **ADX** is now the standard Wilder calculation: it matches charting platforms and is about 30× faster. Live ADX values shift slightly as a result.
- **Dashboard:** new **Track Record** tab.
- `/api/backtest` serves the saved results (a real backtest is too heavy for a serverless request).
- **Removed** the old strategy (`signalService.js`), the old backtester (`backtestService.js`, `utils/helpers.js`) and the stale `backtest-results.json`, which tested a different strategy with look-ahead.
- New `STRATEGY.md` explains the method and how to read the numbers.
- Tests: 39 (11 new for the backtester: trade-plan maths, exact fees, stop-first, gaps, next-open entry, no look-ahead).


## 2.2.0 — Fix & secure

### ⚠️ Do this after deploying
1. Add two new environment variables in Vercel, each a long random string:
   - `CRON_SECRET`
   - `TELEGRAM_WEBHOOK_SECRET` (letters, numbers, `_` and `-` only)
2. Open `https://crptotradingbot.vercel.app/api/set-commands?key=YOUR_CRON_SECRET` once. This re-registers the webhook with the secret.
3. Add `?key=YOUR_CRON_SECRET` to every cron-job.org URL (`v2quickcheck`, `v2monitor`, `v2scan`, `v2listings-alert`, `v2moonshot`).

Until steps 1–2 are done, everything keeps working as before, but the security holes stay open (the logs warn about this).

### Security
- **Webhook verification:** Telegram updates must carry `TELEGRAM_WEBHOOK_SECRET`. Before, anyone could POST a fake update "from" the admin chat ID and get admin powers.
- **Cron key:** endpoints that send messages or change data now require `CRON_SECRET`. `v2scan`, `v2listings` and `signal` still return data publicly (the dashboard uses them), but only keyed calls send alerts.
- **No token leak:** `/api/telegram-test` used to return a URL containing the full bot token. It now requires the key and never echoes the token or chat ID.
- **`/api/set-commands`** requires the key, and now also registers the webhook with its secret.
- **Privacy:** milestone and HOLD alerts for each user's positions used to go to the shared info channel, where every member could see them. They now go only to the owner's chat, delivered silently. The info channel carries market-wide alerts only.
- **Dashboard:** API text is HTML-escaped before display.

### Bugs fixed
- `node index.js`, `node scheduler.js` and `node backtest.js` crashed (`calculateEMA is not a function`).
- `sold SOL 92.5 185` only deleted the position and never recorded the trade, so `profit` stats stayed empty. It now records the trade (using the position's quantity if you don't give one) and removes the matching entry. Plain `sold SOL` still works as `sell`.
- Position advice fetched 50 four-hour candles but EMA200 needs 200+, so the 4H trend was always "UNKNOWN". It now fetches 250.
- `v2moonshot` never alerted: it read `score` and `reasons`, which don't exist. It now uses `probability` and `greenSignals`, with a threshold set by `MOONSHOT_MIN_SCORE` (default 70).
- The 4-hourly HOLD update never fired, because `lastChecked` was reset every 30 minutes. It now has its own timer.
- **Stops and take-profits are locked per position.** They used to be recalculated from the live ATR every check, so they drifted and the two monitors disagreed. They're now saved when you `buy` (or on the first check for older positions).
- "Approaching target" fired every 10 minutes while the price was within 5% of the target. It now fires once.
- Jumping past several 10% milestones used to send them one by one on later runs. Now one alert is sent and all of them are marked.
- Jumping straight to TP2 or TP3 used to leave the lower TPs unmarked, so they alerted later. They're now marked too.
- "Buy #N" numbering was off by one.
- Admin `remove SOL` deleted a *user* lookup instead of the position. Now `remove <numeric id>` removes a user and `remove SOL` removes the position.
- `/command@BotName` didn't work in group chats.
- Messages containing coin names or usernames with `_`, `*` and similar characters were rejected by Telegram and lost silently. They're now re-sent as plain text.
- Duplicate-alert protection was held in memory and reset on every Vercel cold start. It's now stored in Redis.
- Alerts started with `setImmediate` could be frozen after the response on serverless. They're now awaited.
- **The backtest could see the future:** it used the still-forming 1H/4H candle. It now only uses fully closed candles, and a stop that the price gaps through fills at the open. Older `backtest-results.json` files were produced with the leak and look better than reality.
- Profit tracker: "last month" was wrong on the 29th–31st, and a $0 P&L showed as blank.
- Dashboard: listings were always empty, BUY levels and advice levels showed "—", and the TP%/SL% fields were ignored by the API. They're replaced with account size and risk %, which the API does use.
- Scheduler: a failed run no longer kills the process.

### Cleanup
- New shared modules in `src/lib/`: `telegram.js`, `redis.js`, `market.js`, `auth.js`. These replace 5–7 copies each of Telegram sending, Upstash access, Kraken mapping and candle fetching.
- The live strategy was moved from `api/v2scan.js` to `src/services/scanEngine.js`. The scanner, the local runner and `/api/signal` now share it (`/api/signal` used to run an older copy).
- Position advice was moved to `src/services/adviceService.js`.
- `/api/backtest` uses the shared backtester instead of its own copy.
- The unused `telegraf` dependency was removed.
- `vercel.json` now has `cleanUrls`, so `/dashboard` works.
- `.env.example` lists every variable. The README was rewritten.
- Added `npm test`: 28 offline tests (`test/`).

Existing Redis data (users, positions, trades) uses the same keys and format and loads unchanged.
