# External Platform Configuration

Required callback/redirect URLs to register in third-party developer consoles.

## X (Twitter)
- Dev: `https://web-dev.uni-scrm.com/api/auth/x/callback`, `https://link-dev.uni-scrm.com/api/auth/x/callback`
- Prod: `https://web.uni-scrm.com/api/auth/x/callback`, `https://link.uni-scrm.com/api/auth/x/callback`
- Console: https://developer.x.com → App → Authentication settings → Callback URLs

## Google OAuth
- Dev: `https://web-dev.uni-scrm.com/api/auth/google/callback`
- Prod: `https://web.uni-scrm.com/api/auth/google/callback`
- Console: https://console.cloud.google.com → Credentials → OAuth 2.0 Client → Authorized redirect URIs

## TikTok
- Dev: `https://link-dev.uni-scrm.com/api/auth/tiktok/callback`
- Prod: `https://link.uni-scrm.com/api/auth/tiktok/callback`
- Console: TikTok Developer Portal → App → Redirect URI

## Stripe Webhooks
- Dev: `https://admin-dev.uni-scrm.com/api/stripe/webhook`
- Prod: `https://admin.uni-scrm.com/api/stripe/webhook`
- Console: https://dashboard.stripe.com → Webhooks → Add endpoint

## GitHub Secrets
- Page: https://github.com/zcqqq/uniscrm-web/settings/secrets/actions
- Required: X_CLIENT_SECRET, X_CONSUMER_SECRET, X_BEARER_TOKEN, GOOGLE_CLIENT_SECRET, RESEND_API_KEY, TIKTOK_CLIENT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
