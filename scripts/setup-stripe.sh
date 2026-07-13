#!/bin/bash
set -e

# Usage: ./scripts/setup-stripe.sh <env>
# Sets up all Stripe resources (Products, Prices, Webhook) and syncs to admin worker.
# Requires: STRIPE_SECRET_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID env vars.

ENV=${1:?Usage: setup-stripe.sh <env>}
CONFIG="admin/wrangler.toml"
STRIPE_API="https://api.stripe.com/v1"

if [ "$ENV" = "production" ]; then
  WEBHOOK_URL="https://admin.uni-scrm.com/webhooks/stripe"
else
  WEBHOOK_URL="https://admin-dev.uni-scrm.com/webhooks/stripe"
fi

stripe_get() { curl -s -H "Authorization: Bearer $STRIPE_SECRET_KEY" "$STRIPE_API/$1"; }
stripe_post() { curl -s -H "Authorization: Bearer $STRIPE_SECRET_KEY" -X POST "$STRIPE_API/$1" "${@:2}"; }

# --- Products & Prices ---

find_or_create_price() {
  local TIER=$1 AMOUNT=$2 PRODUCT_NAME=$3
  local LOOKUP_KEY="uniscrm_${TIER}_monthly"

  # Check by lookup_key first — but only reuse it if the amount still matches
  # shared/plans.ts (the source of truth for displayed/charged pricing). Prices
  # are immutable in Stripe, so a mismatch means the old price is stale: retire
  # it and fall through to create a fresh one with the same lookup_key.
  local EXISTING_JSON=$(stripe_get "prices?lookup_keys[]=$LOOKUP_KEY&limit=1")
  local EXISTING=$(echo "$EXISTING_JSON" | jq -r '.data[0].id // empty')
  local EXISTING_AMOUNT=$(echo "$EXISTING_JSON" | jq -r '.data[0].unit_amount // empty')
  if [ -n "$EXISTING" ]; then
    if [ "$EXISTING_AMOUNT" = "$AMOUNT" ]; then
      echo "$EXISTING"
      return
    fi
    echo "  Stale price $EXISTING ($EXISTING_AMOUNT cents) != plans.ts ($AMOUNT cents) — retiring" >&2
    stripe_post "prices/$EXISTING" -d "active=false" -d "lookup_key=" > /dev/null
  fi

  # Search for existing product by name
  local PRODUCT_ID=$(stripe_get "products?limit=100" | jq -r --arg n "$PRODUCT_NAME" '.data[] | select(.name == $n and .active == true) | .id' | head -1)

  if [ -z "$PRODUCT_ID" ]; then
    PRODUCT_ID=$(stripe_post "products" -d "name=$PRODUCT_NAME" -d "metadata[tier]=$TIER" | jq -r '.id')
    echo "  Created product: $PRODUCT_NAME ($PRODUCT_ID)" >&2
  else
    echo "  Found product: $PRODUCT_NAME ($PRODUCT_ID)" >&2
  fi

  # Search for existing price on this product
  local PRICE_ID=$(stripe_get "prices?product=$PRODUCT_ID&active=true&limit=20" | \
    jq -r --argjson amt "$AMOUNT" '.data[] | select(.unit_amount == $amt and .recurring.interval == "month") | .id' | head -1)

  if [ -z "$PRICE_ID" ]; then
    PRICE_ID=$(stripe_post "prices" \
      -d "product=$PRODUCT_ID" \
      -d "unit_amount=$AMOUNT" \
      -d "currency=usd" \
      -d "recurring[interval]=month" \
      -d "lookup_key=$LOOKUP_KEY" | jq -r '.id')
    echo "  Created price: $AMOUNT cents/mo ($PRICE_ID)" >&2
  else
    echo "  Found price: $AMOUNT cents/mo ($PRICE_ID)" >&2
  fi

  echo "$PRICE_ID"
}

echo "💳 Setting up Stripe prices..."
# Amounts (cents) must match shared/plans.ts TIERS[tier].price_monthly — that's the
# source of truth the UI displays and quotes to customers.
PRICE_BASIC=$(find_or_create_price "basic" 2000 "UniSCRM Basic")
PRICE_PRO=$(find_or_create_price "pro" 10000 "UniSCRM Pro")

echo "$PRICE_BASIC" | npx wrangler secret put STRIPE_PRICE_BASIC --env "$ENV" --config "$CONFIG"
echo "$PRICE_PRO" | npx wrangler secret put STRIPE_PRICE_PRO --env "$ENV" --config "$CONFIG"
echo "✅ Prices synced: Basic=$PRICE_BASIC Pro=$PRICE_PRO"

# --- Webhook ---

EVENTS="checkout.session.completed,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed"
echo "🔗 Setting up Stripe webhook: $WEBHOOK_URL"

EXISTING_WH=$(stripe_get "webhook_endpoints?limit=100" | \
  jq -r --arg url "$WEBHOOK_URL" '.data[] | select(.url == $url) | .id' | head -1)

if [ -n "$EXISTING_WH" ]; then
  echo "  Updating existing endpoint: $EXISTING_WH"
  RESULT=$(stripe_post "webhook_endpoints/$EXISTING_WH" \
    -d "enabled_events[]=$(echo $EVENTS | sed 's/,/\&enabled_events[]=/g')" \
    -d "url=$WEBHOOK_URL")
  WH_SECRET=$(echo "$RESULT" | jq -r '.secret // empty')
else
  echo "  Creating new endpoint"
  RESULT=$(stripe_post "webhook_endpoints" \
    -d "url=$WEBHOOK_URL" \
    -d "enabled_events[]=$(echo $EVENTS | sed 's/,/\&enabled_events[]=/g')")
  WH_SECRET=$(echo "$RESULT" | jq -r '.secret // empty')
  if [ -z "$WH_SECRET" ]; then
    echo "❌ Failed to create webhook:"
    echo "$RESULT" | jq .
    exit 1
  fi
fi

if [ -n "$WH_SECRET" ]; then
  echo "$WH_SECRET" | npx wrangler secret put STRIPE_WEBHOOK_SECRET --env "$ENV" --config "$CONFIG"
  echo "✅ Webhook secret synced"
else
  echo "✅ Webhook updated (secret unchanged)"
fi

echo "✅ Stripe setup complete for $ENV"
