#!/bin/bash
set -e

ENV=${1:-dev}
echo "Setting up environment: $ENV"

if [ "$ENV" = "dev" ]; then
  SUFFIX="-dev"
elif [ "$ENV" = "production" ]; then
  SUFFIX=""
else
  echo "Usage: ./scripts/setup-env.sh [dev|production]"
  exit 1
fi

resolve_or_create_d1() {
  local name="$1"
  local id=$(wrangler d1 list --json 2>/dev/null | jq -r ".[] | select(.name==\"$name\") | .uuid")
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    echo "Creating D1: $name" >&2
    id=$(wrangler d1 create "$name" 2>/dev/null | jq -r '.database_id // empty')
    if [ -z "$id" ]; then
      id=$(wrangler d1 create "$name" 2>&1 | grep '"database_id"' | sed 's/.*"database_id": "//;s/".*//')
    fi
  fi
  echo "$id"
}

resolve_or_create_kv() {
  local name="$1"
  local id=$(wrangler kv namespace list 2>/dev/null | jq -r ".[] | select(.title==\"$name\") | .id")
  if [ -z "$id" ] || [ "$id" = "null" ]; then
    echo "Creating KV: $name" >&2
    id=$(wrangler kv namespace create "$name" 2>/dev/null | jq -r '.id // empty')
    if [ -z "$id" ]; then
      id=$(wrangler kv namespace create "$name" 2>&1 | grep '"id"' | head -1 | sed 's/.*"id": "//;s/".*//')
    fi
  fi
  echo "$id"
}

update_toml() {
  local file="$1"
  local placeholder="$2"
  local value="$3"
  sed -i '' "s|$placeholder|$value|g" "$file" 2>/dev/null || sed -i "s|$placeholder|$value|g" "$file"
}

echo "Resolving D1 databases..."
WEB_DB_ID=$(resolve_or_create_d1 "uniscrm-web${SUFFIX}")
LINK_DB_ID=$(resolve_or_create_d1 "uniscrm-link${SUFFIX}")
FLOW_DB_ID=$(resolve_or_create_d1 "uniscrm-flow${SUFFIX}")
ADMIN_DB_ID=$(resolve_or_create_d1 "uniscrm-admin${SUFFIX}")
ANALYTICS_DB_ID=$(resolve_or_create_d1 "uniscrm-analytics${SUFFIX}")

echo "Resolving KV namespaces..."
KV_ID=$(resolve_or_create_kv "uniscrm-kv${SUFFIX}")
TREND_KV_ID=$(resolve_or_create_kv "uniscrm-trend-kv${SUFFIX}")

echo ""
echo "=== Resource IDs for $ENV ==="
echo "WEB_DB:      $WEB_DB_ID"
echo "LINK_DB:     $LINK_DB_ID"
echo "FLOW_DB:     $FLOW_DB_ID"
echo "ADMIN_DB:    $ADMIN_DB_ID"
echo "ANALYTICS_DB: $ANALYTICS_DB_ID"
echo "KV:          $KV_ID"
echo "TREND_KV:    $TREND_KV_ID"
echo ""

MODULES=(web link flow admin analytics insight-segment profile trend-skill)
for module in "${MODULES[@]}"; do
  toml="$module/wrangler.toml"
  if [ ! -f "$toml" ]; then continue; fi

  echo "Updating $toml..."

  # D1 IDs — match by database_name on preceding line
  if grep -q "uniscrm-web${SUFFIX}" "$toml"; then
    # Find line with database_name, next line has database_id
    awk -v name="uniscrm-web${SUFFIX}" -v id="$WEB_DB_ID" '
      /database_name/ && $0 ~ name { found=1; print; next }
      found && /database_id/ { sub(/database_id = ".*"/, "database_id = \"" id "\""); found=0 }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  fi

  if grep -q "uniscrm-link${SUFFIX}" "$toml"; then
    awk -v name="uniscrm-link${SUFFIX}" -v id="$LINK_DB_ID" '
      /database_name/ && $0 ~ name { found=1; print; next }
      found && /database_id/ { sub(/database_id = ".*"/, "database_id = \"" id "\""); found=0 }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  fi

  if grep -q "uniscrm-flow${SUFFIX}" "$toml"; then
    awk -v name="uniscrm-flow${SUFFIX}" -v id="$FLOW_DB_ID" '
      /database_name/ && $0 ~ name { found=1; print; next }
      found && /database_id/ { sub(/database_id = ".*"/, "database_id = \"" id "\""); found=0 }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  fi

  if grep -q "uniscrm-admin${SUFFIX}" "$toml"; then
    awk -v name="uniscrm-admin${SUFFIX}" -v id="$ADMIN_DB_ID" '
      /database_name/ && $0 ~ name { found=1; print; next }
      found && /database_id/ { sub(/database_id = ".*"/, "database_id = \"" id "\""); found=0 }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  fi

  if grep -q "uniscrm-analytics${SUFFIX}" "$toml"; then
    awk -v name="uniscrm-analytics${SUFFIX}" -v id="$ANALYTICS_DB_ID" '
      /database_name/ && $0 ~ name { found=1; print; next }
      found && /database_id/ { sub(/database_id = ".*"/, "database_id = \"" id "\""); found=0 }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  fi

  # KV namespace IDs
  if [ "$module" = "trend-skill" ]; then
    # trend-skill uses TREND_KV
    awk -v id="$TREND_KV_ID" '
      /binding = "TREND_KV"/ { print; getline; sub(/id = ".*"/, "id = \"" id "\""); print; next }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  elif grep -q 'binding = "KV"' "$toml"; then
    awk -v id="$KV_ID" '
      /binding = "KV"/ { print; getline; sub(/id = ".*"/, "id = \"" id "\""); print; next }
      { print }
    ' "$toml" > "$toml.tmp" && mv "$toml.tmp" "$toml"
  fi
done

echo ""
echo "✅ All wrangler.toml files updated for $ENV environment."
echo ""
echo "Next steps:"
echo "  1. Run migrations: ./scripts/migrate-all.sh $ENV"
echo "  2. Deploy workers: ./scripts/deploy-all.sh $ENV"
