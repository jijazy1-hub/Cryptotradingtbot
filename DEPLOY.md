# Deploy: GitHub Codespaces → Vercel

## 1. Put the project in your Codespace
Open your repo in a Codespace, drag `Crptotradingbot-v2.23.zip` into the file explorer (root of the repo), then in the terminal:
```bash
unzip -o Crptotradingbot-v2.23.zip && rm Crptotradingbot-v2.23.zip
```
This overlays your files (including the hidden `.env`).

## 2. Install and test (once)
```bash
bash scripts/codespace-setup.sh
```
This installs packages, runs the 187 offline tests and tells you which settings in `.env` are still empty.

## 3. Fill the empty keys in `.env`
These were empty in the file you uploaded — the bot will not work without the first three:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (and `PAYSTACK_SECRET_KEY` if you take payments).
If they are already set in **Vercel → Settings → Environment Variables**, you can leave them empty here.

> **Binance keys are NOT in `.env`.** Each user connects their own key in Telegram (`golive` / `autotrade connect KEY SECRET`); the bot stores it encrypted in Upstash using `TRADING_ENCRYPTION_KEY`. Never change that value once people have connected, or their saved keys stop working.

## 4. Deploy to Vercel
```bash
bash scripts/deploy.sh
```
It runs the tests, links the folder to your Vercel project (**pick the existing project**), adds the `.env` values Vercel is missing, deploys to production and registers the Telegram webhook.
Tip: create a token at vercel.com/account/tokens and `export VERCEL_TOKEN=...` to skip the login prompt.

- Variables that already exist on Vercel are **left alone**. To replace them: `bash scripts/push-env-to-vercel.sh --overwrite` (`TRADING_ENCRYPTION_KEY` is never replaced).
- Preview what would be added: `bash scripts/push-env-to-vercel.sh --dry-run`.

## 5. Push to GitHub
```bash
git add .
git commit -m "v2.23: all Binance coins + daily close"
git push
```
`.env` is in `.gitignore`, so your keys are **not** pushed. If your Vercel project is connected to this GitHub repo, every push also redeploys it.

## 6. Check it
- `https://YOUR-SITE/api/health?key=YOUR_CRON_SECRET`
- In Telegram: `autobuy` (settings), `stops` (today's signals across all coins), and `autobuy run` as admin to force a daily run.
- Keep your external cron (cron-job.org) hitting `/api/v2monitor?key=YOUR_CRON_SECRET` every 30 minutes. A daily Vercel cron on the same endpoint is the backup.

## Settings (Vercel → Environment Variables)
| Name | Default | Meaning |
|---|---|---|
| `AUTOBUY_UNIVERSE` | `ALL` | `ALL` = every liquid Binance USDT coin; or a list such as `BTC,ETH,SOL` |
| `AUTOBUY_MIN_VOLUME_USD` | `1000000` | ignore coins that traded less than this in 24h (`0` = no floor) |
| `AUTOBUY_MAX_COINS` | `400` | most coins to check, most-traded first |
| `AUTOBUY_DAILY_CLOSE` | `true` | sell every auto-bought position at the daily run; `false` = hold until the trailing stop |
| `AUTOBUY_FETCH_BUDGET_SEC` | `30` | stop starting new coins after this long (Vercel's limit is 60 s) |
