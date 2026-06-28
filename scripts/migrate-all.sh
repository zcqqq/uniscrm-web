#!/bin/bash
set -e

ENV=${1:-dev}
echo "Running migrations for: $ENV"

migrate() {
  local db_name="$1"
  local config="$2"
  echo "📋 Migrating $db_name..."
  wrangler d1 migrations apply "$db_name" --env "$ENV" --config "$config" --remote 2>&1 | tail -5
  echo ""
}

migrate "uniscrm-web-${ENV}" "web/wrangler.toml"
migrate "uniscrm-link-${ENV}" "link/wrangler.toml"
migrate "uniscrm-flow-${ENV}" "flow/wrangler.toml"
migrate "uniscrm-admin-${ENV}" "admin/wrangler.toml"

echo "✅ All migrations complete."
