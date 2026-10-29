#!/usr/bin/env bash
# Copies the NON-EMPTY values in .env to your Vercel project's Production environment.
# Vercel does not read .env files, and .env must never go to GitHub, so this is how keys reach Vercel.
#
# SAFE BY DEFAULT: a variable that already exists on Vercel is left alone.
#   bash scripts/push-env-to-vercel.sh              # add only what's missing
#   bash scripts/push-env-to-vercel.sh --dry-run    # list the variable NAMES that would be added
#   bash scripts/push-env-to-vercel.sh --overwrite  # also replace existing values (never TRADING_ENCRYPTION_KEY)
#
# TRADING_ENCRYPTION_KEY is never replaced: users' saved Binance keys are encrypted with it, so changing it
# makes them unreadable and everyone would have to reconnect.
# Optional: export VERCEL_TOKEN=...  (vercel.com/account/tokens) to skip the interactive login.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=0; OVERWRITE=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --overwrite) OVERWRITE=1;; *) echo "Unknown option $a"; exit 1;; esac; done
[ -f .env ] || { echo "No .env file here."; exit 1; }

TOKEN_ARGS=(); [ -n "${VERCEL_TOKEN:-}" ] && TOKEN_ARGS=(--token "$VERCEL_TOKEN")
VC=(npx --yes vercel@latest)

added=0; kept=(); skipped=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  key="${line%%=*}"; val="${line#*=}"
  if [[ "$val" =~ ^\".*\"$ || "$val" =~ ^\'.*\'$ ]]; then val="${val:1:${#val}-2}"; fi   # strip one pair of quotes
  [ "$key" = "CRON_SCHEDULE" ] && continue   # only used by the local scheduler
  if [ -z "$val" ]; then skipped+=("$key"); continue; fi
  if [ "$DRY" = 1 ]; then echo "would add (if missing on Vercel): $key"; continue; fi

  if out=$(printf '%s' "$val" | "${VC[@]}" env add "$key" production "${TOKEN_ARGS[@]}" 2>&1); then
    echo "added:    $key"; added=$((added+1))
  elif grep -qi "already" <<<"$out"; then
    if [ "$OVERWRITE" = 1 ] && [ "$key" != "TRADING_ENCRYPTION_KEY" ]; then
      "${VC[@]}" env rm "$key" production --yes "${TOKEN_ARGS[@]}" >/dev/null || { echo "✖ Couldn't remove the old $key — nothing changed for it."; exit 1; }
      printf '%s' "$val" | "${VC[@]}" env add "$key" production "${TOKEN_ARGS[@]}" >/dev/null \
        || { echo "✖ $key was REMOVED but adding the new value failed. Add it by hand: Vercel → Settings → Environment Variables."; exit 1; }
      echo "replaced: $key"; added=$((added+1))
    else
      echo "kept:     $key (already on Vercel)"; kept+=("$key")
    fi
  else
    echo "✖ Vercel refused $key:"; echo "$out"; exit 1
  fi
done < .env

[ "$DRY" = 1 ] && exit 0
echo "✔ $added variable(s) added/replaced on Vercel (Production)."
[ ${#kept[@]} -gt 0 ] && echo "ℹ️  Left as they were on Vercel: ${kept[*]}"
if [ ${#skipped[@]} -gt 0 ]; then
  echo "⚠️  EMPTY in .env, so not sent: ${skipped[*]}"
  echo "    If they aren't already set in Vercel → Settings → Environment Variables, the bot needs at least"
  echo "    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and both UPSTASH_* values."
fi
