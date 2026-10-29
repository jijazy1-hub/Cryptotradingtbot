#!/usr/bin/env bash
# One command: tests → env vars to Vercel → production deploy → register the Telegram webhook.
#   bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN_ARGS=(); [ -n "${VERCEL_TOKEN:-}" ] && TOKEN_ARGS=(--token "$VERCEL_TOKEN")
VC=(npx --yes vercel@latest)

echo "▶ Tests…"; npm test --silent

if [ ! -f .vercel/project.json ]; then
  echo "▶ Linking this folder to your Vercel project (choose the EXISTING project, e.g. crptotradingbot)…"
  "${VC[@]}" link "${TOKEN_ARGS[@]}"
fi

echo "▶ Sending .env values to Vercel…"
bash scripts/push-env-to-vercel.sh

echo "▶ Deploying to production…"
"${VC[@]}" deploy --prod --yes "${TOKEN_ARGS[@]}"

set -a; . ./.env; set +a
if [ -n "${PUBLIC_BASE_URL:-}" ] && [ -n "${CRON_SECRET:-}" ]; then
  echo "▶ Registering the Telegram menu + webhook…"
  curl -fsS "${PUBLIC_BASE_URL%/}/api/set-commands?key=${CRON_SECRET}" && echo || echo "⚠️  Couldn't reach ${PUBLIC_BASE_URL} yet — open /api/set-commands?key=YOUR_CRON_SECRET in a browser once it's live."
fi
echo "✅ Done. Check: ${PUBLIC_BASE_URL:-your-site}/api/health?key=YOUR_CRON_SECRET"
