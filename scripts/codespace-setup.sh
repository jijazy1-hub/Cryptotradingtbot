#!/usr/bin/env bash
# Run once after dragging the project into your Codespace:   bash scripts/codespace-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Installing packages…"
npm install --no-audit --no-fund

echo "▶ Running the offline tests…"
npm test

if [ ! -f .env ]; then
  echo "⚠️  No .env file found. Copy .env.example to .env and fill in your keys."
else
  blank=$(grep -E '^[A-Z_]+=$' .env | cut -d= -f1 | tr '\n' ' ' || true)
  [ -n "$blank" ] && echo "⚠️  These settings in .env are still EMPTY: $blank"
fi

cat <<'MSG'

✅ Ready. Next:
   1) bash scripts/deploy.sh          → sends your .env to Vercel and deploys
   2) git add . && git commit -m "v2.23: all Binance coins + daily close" && git push
      (.env is git-ignored, so your keys are NOT pushed to GitHub)
MSG
