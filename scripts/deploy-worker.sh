#!/usr/bin/env bash
# deploy-worker.sh — deploy the Cloudflare Worker without an interactive login.
#
#   bash scripts/deploy-worker.sh            deploy
#   bash scripts/deploy-worker.sh --dry-run  build only, no upload
#
# Uses the API token stored by scripts/set-cf-token.js (first readable copy, so
# an iCloud-evicted file is not a single point of failure). With no token it
# falls back to whatever `wrangler login` session exists — which expires about
# weekly, which is why the token path is preferred.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$REPO/.." && pwd)"

for f in "$ROOT/.fx-deploy/cf_token" "$ROOT/.fx-deploy/cf_token.bak" "$REPO/.cf_token"; do
  if [ -r "$f" ] && [ -s "$f" ]; then
    CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$f")"
    export CLOUDFLARE_API_TOKEN
    echo "using API token from $f"
    break
  fi
done

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "no stored API token (scripts/set-cf-token.js) — falling back to the wrangler login session"
fi

cd "$REPO/proxy"
exec npx wrangler deploy "$@"
