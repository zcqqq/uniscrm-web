#!/bin/bash
set -e

# Usage: ./scripts/seed-e2e.sh <env>
# Seeds a test tenant, member, and session into WEB_DB for E2E testing.
# The session UUID is deterministic so Playwright can inject it as a cookie.

ENV=${1:?Usage: seed-e2e.sh <env>}
CONFIG="web/wrangler.toml"
DB_NAME="uniscrm-web-${ENV}"

E2E_TENANT_ID=99999
E2E_MEMBER_ID="e2e-test-member-00000000-0000-0000-0000-000000000001"
E2E_SESSION_ID="e2e-test-session-00000000-0000-0000-0000-000000000001"
E2E_EMAIL="e2e-test@uni-scrm.com"

echo "🌱 Seeding E2E test data into $DB_NAME ($ENV)..."

npx wrangler d1 execute "$DB_NAME" --env "$ENV" --config "$CONFIG" --remote --command "
INSERT OR REPLACE INTO tenants (tenant_id, email, created_at)
VALUES ($E2E_TENANT_ID, '$E2E_EMAIL', datetime('now'));

INSERT OR REPLACE INTO members (id, tenant_id, email, language, timezone, created_at)
VALUES ('$E2E_MEMBER_ID', $E2E_TENANT_ID, '$E2E_EMAIL', 'en', 'UTC', datetime('now'));

INSERT OR REPLACE INTO sessions (id, member_id, tenant_id, email, language, expires_at, created_at)
VALUES ('$E2E_SESSION_ID', '$E2E_MEMBER_ID', $E2E_TENANT_ID, '$E2E_EMAIL', 'en', datetime('now', '+30 days'), datetime('now'));
"

echo "✅ E2E seed complete. Session ID: $E2E_SESSION_ID"
