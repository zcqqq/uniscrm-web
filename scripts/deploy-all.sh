#!/bin/bash
set -e

ENV=${1:-dev}
echo "Deploying all workers to: $ENV"

MODULES=(web link flow admin insight-segment trend-skill)

for module in "${MODULES[@]}"; do
  toml="$module/wrangler.toml"
  if [ ! -f "$toml" ]; then
    echo "⚠️  Skipping $module (no wrangler.toml)"
    continue
  fi

  # Build frontend if exists
  if [ -f "$module/vite.config.ts" ]; then
    echo "📦 Building $module frontend..."
    (cd "$module" && npx vite build)
  fi

  echo "🚀 Deploying $module..."
  wrangler deploy --env "$ENV" --config "$toml"
  echo ""
done

echo "✅ All workers deployed to $ENV."
echo ""
echo "Health checks:"
if [ "$ENV" = "dev" ]; then
  curl -s https://web-dev.uni-scrm.com/health && echo ""
  curl -s https://link-dev.uni-scrm.com/health && echo ""
  curl -s https://flow-dev.uni-scrm.com/health && echo ""
  curl -s https://admin-dev.uni-scrm.com/health && echo ""
fi
