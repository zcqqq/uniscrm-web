# Federated Authentication Design

## Context

UniSCRM currently supports only passwordless magic-link authentication via Resend. Users want faster login via Google/X OAuth, and the ability to link OAuth identities to existing email accounts. Email remains the universal user identifier.

## Requirements

1. **Google OAuth login** — uses Google's verified email as account identifier
2. **X (Twitter) OAuth login** — if email unavailable, prompt user to enter and verify one via Resend
3. **Auto-merge** — if OAuth email matches an existing user, link the OAuth identity to that user automatically
4. **Account linking** — authenticated users can connect/disconnect Google/X from Settings
5. **Login page redesign** — social buttons on top, divider, email form below

## Architecture

OAuth uses the **Arctic** library (lightweight, edge-compatible, handles PKCE/state). OAuth flow state stored in KV with 5-minute TTL. The existing session infrastructure (KV + cookie) is reused — OAuth is just another way to resolve a user before creating a session.

New table `oauth_accounts` links provider identities to users (many-to-one). The `users` table is unchanged.

## Database

New migration `0005_create_oauth_accounts.sql`:

```sql
CREATE TABLE oauth_accounts (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX idx_oauth_accounts_user ON oauth_accounts(user_id);
```

## OAuth Flow

### Google

1. `GET /api/auth/google` — generate state + PKCE code verifier, store in KV (`oauth_state:{state}`, TTL 5min), redirect to Google authorize URL
2. Google redirects to `GET /api/auth/google/callback` — validate state, exchange code for tokens, fetch userinfo (email always present)
3. Lookup `oauth_accounts` by (google, sub) → existing user? Log in. No entry? Check if email matches existing user → create oauth_account link. No user at all? Create user + oauth_account. Set session cookie, redirect to `/`.

### X (Twitter)

Same flow as Google, but:
- Uses OAuth 2.0 with PKCE (X API v2)
- If X does not return an email: store X identity in KV as `pending_oauth:{pendingId}` (5min TTL), set a temporary cookie `pending_oauth`, redirect to `/auth/complete-profile`
- CompleteProfile page: user enters email → `POST /api/auth/complete-profile` sends 6-digit code via Resend → user enters code → `POST /api/auth/verify-code` validates, creates user + oauth_account, sets session

### Account Linking (from Settings)

1. User clicks "Connect Google/X" → `GET /api/auth/google?link=true` (or x)
2. Callback sees user is already authenticated → just insert into `oauth_accounts` linking provider identity to current user
3. If provider identity already linked to a different user → return error

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/auth/google` | No | Start Google OAuth |
| GET | `/api/auth/google/callback` | No | Google OAuth callback |
| GET | `/api/auth/x` | No | Start X OAuth |
| GET | `/api/auth/x/callback` | No | X OAuth callback |
| POST | `/api/auth/complete-profile` | No | Submit email for pending X signup |
| POST | `/api/auth/verify-code` | No | Verify email code for pending X signup |
| GET | `/api/settings/linked-accounts` | Yes | List linked OAuth providers |
| DELETE | `/api/settings/linked-accounts/:provider` | Yes | Unlink an OAuth provider |

## Worker Files

| File | Purpose |
|------|---------|
| `worker/api/oauth.ts` | OAuth route handlers (redirect + callback for both providers) |
| `worker/services/oauth.ts` | OAuth business logic: state management, user lookup/merge/create |

## Frontend

| File | Change |
|------|--------|
| `src/pages/Login.tsx` | Add "Continue with Google" / "Continue with X" buttons above email form |
| `src/pages/CompleteProfile.tsx` | New — email input + 6-digit code verification for X users without email |
| `src/App.tsx` | Add route `/auth/complete-profile` |
| `src/pages/Settings.tsx` | New — "Connected Accounts" section with connect/disconnect buttons |

## Environment Variables

New secrets (per environment):
- `GOOGLE_CLIENT_ID` — wrangler.toml var
- `GOOGLE_CLIENT_SECRET` — wrangler secret
- `X_CLIENT_ID` — wrangler.toml var
- `X_CLIENT_SECRET` — wrangler secret

Add to `Env` interface in `worker/types.ts`:
```typescript
GOOGLE_CLIENT_ID: string;
GOOGLE_CLIENT_SECRET: string;
X_CLIENT_ID: string;
X_CLIENT_SECRET: string;
```

## Email Verification (CompleteProfile)

Reuse Resend integration. New method in `EmailService`:
- `sendVerificationCode(email, code)` — sends 6-digit numeric code, 10-minute expiry
- Code stored in KV as `email_code:{email}` with 10min TTL

## Security

- PKCE (S256) for both providers — prevents authorization code interception
- State parameter validated on callback — prevents CSRF
- OAuth state in KV with 5min TTL — auto-expires
- Email verification code: 6 digits, 10min TTL, max 3 attempts stored in KV
- Existing session cookie settings unchanged (httpOnly, secure, sameSite=Lax)

## Testing

- Unit tests for `OAuthService` (state creation, user merge logic, link/unlink)
- Integration test: mock Arctic provider responses, verify full callback flow
- Manual: Google OAuth with real credentials in dev environment
- Manual: X OAuth callback with/without email scenario
