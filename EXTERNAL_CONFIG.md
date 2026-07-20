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
- Console: https://developers.tiktok.com → App → Redirect URI


## Cloudflare Email Service (auth emails)
- Sender: `noreply@uni-scrm.com` via `send_email` binding (`EMAIL_WEB` in web worker), no API key needed
- One-time setup: Cloudflare Dashboard → Compute → Email Service → Email Sending → Onboard Domain `uni-scrm.com` (requires Workers Paid; auto-adds SPF/DKIM/DMARC on `cf-bounce` subdomain)

## GitHub Secrets
- Page: https://github.com/zcqqq/uniscrm-web/settings/secrets/actions
- Required: X_CLIENT_SECRET, X_CONSUMER_SECRET, X_BEARER_TOKEN, GOOGLE_CLIENT_SECRET, TIKTOK_CLIENT_SECRET, STRIPE_SECRET_KEY
