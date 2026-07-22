#!/bin/bash
set -e

# Usage: ./scripts/sync-secrets.sh <env> <module> <config>
# Reads .secrets.json from module dir, builds a JSON object from GitHub secrets env vars,
# and pushes them to the CF worker via wrangler secret bulk.

ENV=${1:?Usage: sync-secrets.sh <env> <module> <config>}
MODULE=${2:?Usage: sync-secrets.sh <env> <module> <config>}
CONFIG=${3:?Usage: sync-secrets.sh <env> <module> <config>}

SECRETS_FILE="$MODULE/.secrets.json"
if [ ! -f "$SECRETS_FILE" ]; then
  echo "✅ No .secrets.json for $MODULE — skipping"
  exit 0
fi

REQUIRED=$(jq -r ".${ENV}[]?" "$SECRETS_FILE" 2>/dev/null)
if [ -z "$REQUIRED" ]; then
  echo "✅ No secrets required for $MODULE ($ENV)"
  exit 0
fi

MISSING=""
BULK_JSON="{"
FIRST=true

for SECRET_NAME in $REQUIRED; do
  VALUE="${!SECRET_NAME}"
  if [ -z "$VALUE" ]; then
    MISSING="$MISSING $SECRET_NAME"
  else
    if [ "$FIRST" = true ]; then
      FIRST=false
    else
      BULK_JSON="$BULK_JSON,"
    fi
    ESCAPED=$(echo -n "$VALUE" | jq -Rs '.')
    BULK_JSON="$BULK_JSON\"$SECRET_NAME\":$ESCAPED"
  fi
done

BULK_JSON="$BULK_JSON}"

if [ -n "$MISSING" ]; then
  echo "❌ Missing GitHub secrets for $MODULE ($ENV):$MISSING"
  echo "   Add these to GitHub repo secrets and re-run."
  exit 1
fi

# The Cloudflare API rate-limits the secrets-bulk endpoint (error 10429) when
# many workers are synced in a short window — including budget consumed by other
# wrangler activity against the same account. Retry with exponential backoff so a
# transient limit self-heals instead of failing the whole deploy pipeline.
ATTEMPTS=5
DELAY=15
for i in $(seq 1 "$ATTEMPTS"); do
  if echo "$BULK_JSON" | npx wrangler secret bulk --env "$ENV" --config "$CONFIG"; then
    echo "✅ Secrets synced for $MODULE ($ENV)"
    exit 0
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "⚠️  secret bulk failed for $MODULE ($ENV) — attempt $i/$ATTEMPTS, retrying in ${DELAY}s (Cloudflare API may be rate-limited: 10429)"
    sleep "$DELAY"
    DELAY=$((DELAY * 2))
  fi
done
echo "❌ secret bulk failed for $MODULE ($ENV) after $ATTEMPTS attempts"
exit 1
