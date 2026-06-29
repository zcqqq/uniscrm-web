#!/bin/bash
set -e

# Usage: ./scripts/setup-stripe-webhook.sh <env>
# Registers or updates Stripe webhook endpoint for the given environment.
# Requires: STRIPE_SECRET_KEY env var
# Sets STRIPE_WEBHOOK_SECRET on the admin worker via wrangler secret.

ENV=${1:?Usage: setup-stripe-webhook.sh <env>}

if [ "$ENV" = "production" ]; then
  WEBHOOK_URL="https://admin.uni-scrm.com/webhooks/stripe"
else
  WEBHOOK_URL="https://admin-dev.uni-scrm.com/webhooks/stripe"
fi

EVENTS="checkout.session.completed,customer.subscription.updated,customer.subscription.deleted,invoice.payment_failed"

echo "🔗 Setting up Stripe webhook: $WEBHOOK_URL"

EXISTING=$(curl -s -H "Authorization: Bearer $STRIPE_SECRET_KEY" \
  "https://api.stripe.com/v1/webhook_endpoints?limit=100" | \
  jq -r ".data[] | select(.url == \"$WEBHOOK_URL\") | .id" | head -1)

if [ -n "$EXISTING" ]; then
  echo "📝 Updating existing endpoint: $EXISTING"
  RESULT=$(curl -s -X POST -H "Authorization: Bearer $STRIPE_SECRET_KEY" \
    "https://api.stripe.com/v1/webhook_endpoints/$EXISTING" \
    -d "enabled_events[]=$(echo $EVENTS | sed 's/,/\&enabled_events[]=/g')" \
    -d "url=$WEBHOOK_URL")
  SECRET=$(echo "$RESULT" | jq -r '.secret // empty')
  if [ -z "$SECRET" ]; then
    echo "✅ Webhook updated (secret unchanged, already set)"
    exit 0
  fi
else
  echo "🆕 Creating new endpoint"
  RESULT=$(curl -s -X POST -H "Authorization: Bearer $STRIPE_SECRET_KEY" \
    "https://api.stripe.com/v1/webhook_endpoints" \
    -d "url=$WEBHOOK_URL" \
    -d "enabled_events[]=$(echo $EVENTS | sed 's/,/\&enabled_events[]=/g')")
  SECRET=$(echo "$RESULT" | jq -r '.secret // empty')
  if [ -z "$SECRET" ]; then
    echo "❌ Failed to create webhook endpoint:"
    echo "$RESULT" | jq .
    exit 1
  fi
fi

echo "$SECRET" | npx wrangler secret put STRIPE_WEBHOOK_SECRET --env "$ENV" --config admin/wrangler.toml
echo "✅ Stripe webhook configured and secret synced"
