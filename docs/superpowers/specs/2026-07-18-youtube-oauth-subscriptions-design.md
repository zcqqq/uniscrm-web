# YouTube OAuth Subscription-Discovery Design

## Context

The just-shipped YouTube content trigger ([2026-07-18-youtube-content-trigger-design.md](2026-07-18-youtube-content-trigger-design.md)) lets a tenant watch an arbitrary public YouTube channel by pasting its URL into the flow node's Inspector. Researching the YouTube Data API surfaced that there's no OAuth-based push mechanism to replace WebSub with (WebSub remains the only free push option, and it's inherently per-channel, not account-scoped) — but there *is* an OAuth-based **pull** endpoint, `subscriptions.list?mine=true`, that returns the channels a tenant's own YouTube account is subscribed to. This design replaces the manual URL-paste flow with: connect your YouTube account once (OAuth), then pick which of your subscriptions to actually watch from the discovered list. The underlying WebSub ingestion pipeline (Data API fetch, face detection, content upsert, cron renewal, engine matching) is entirely unchanged — this only changes how a tenant tells the system which channels to watch.

## Decisions

- **Full replacement**, not a dual-mode: the URL-paste UI and `POST /youtube/watch` route are deleted, not kept alongside the new flow.
- **Tenant picks from the discovered list** — connecting OAuth only fetches and caches the subscription list; it does not auto-subscribe WebSub for everything (a tenant could be subscribed to hundreds of channels).
- **One-time sync**, no periodic re-sync cron in v1 — the cached list refreshes only when the tenant re-runs OAuth connect. Picking up newly-subscribed channels requires a manual re-connect. This is an accepted v1 limitation, not silently designed around.
- **System-shared OAuth client** (like TikTok, not BYOK like X) — one Google Cloud OAuth client for the whole system, distinct from the existing `YOUTUBE_API_KEY`.
- **No refresh token / `access_type=offline`** — the access token is used exactly once, synchronously, inside the OAuth callback's background sync task, and never touched again. Requesting offline access would mean storing a long-lived credential that's never used, for no benefit under the one-time-sync decision above.
- **Silent overwrite on re-connect**, matching X/TikTok's existing plain-connect behavior (not the extra same-account-different-tenant guard that only exists on X's *BYOK* path) — no new confirmation UX.
- **Unbounded subscription-list pagination** for v1 — quota cost is low (1 unit/page regardless of page size), and this repo has no real customers yet. A pathologically large account could run long inside the background task; accepted as a v1 tradeoff, not solved here.
- **`youtube.readonly` is a deliberate exception** to this repo's general "prefer maximal OAuth scope" policy (CLAUDE.md) — a broader YouTube scope would only worsen Google's sensitive-scope app-verification requirements (see Risks) for no functional benefit, since nothing beyond the subscription list is ever read.

## Data model

New `channels.channel_type` value: **`YOUTUBE_ACCOUNT`** — one row per tenant, no schema change needed (reuses existing `access_token`/`config`/`source_channel_id`/`tenant_id`/`member_id` columns). `source_channel_id = "{tenantId}:{googleUserId}"` (tenant-scoped, same encoding and same reason as the existing `YOUTUBE` watched-channel rows — the shared `channels` table's global `UNIQUE(channel_type, source_channel_id)` index must not be migrated). `config`: `{ google_user_id, email, name, access_token, expires_at, subscriptions: [{channelId, channelName, thumbnailUrl}], sync_status: "pending"|"done"|"error", last_synced_at }`.

`channel_type = 'YOUTUBE'` watched-channel rows are **unchanged in shape** — rows created by the old URL-paste flow keep working exactly as before (WebSub lease, cron renewal, engine matching all untouched), no migration or cleanup needed. A `YOUTUBE_ACCOUNT` row is only needed to discover *new* channels to watch, not to keep already-watched ones running.

**Disconnect isolation, explicit and tested**: deactivating `YOUTUBE_ACCOUNT` must never cascade to any `YOUTUBE` watched-channel row, never call `unsubscribeWebSub`, never affect a flow's trigger. This is the same category of bug the earlier cron-renewal fix (Task 8 of the original feature) already fixed once this session — worth a dedicated test, not just review discipline.

## API surface (`link` module)

**`link/src/oauth.ts`** (mirrors the existing X PKCE flow, since `arctic`'s `Google` provider has an identical shape to `Twitter`'s — verified via `arcticjs.dev`, not guessed):
- `GET /youtube/connect` — state+KV, `Google(clientId, clientSecret, redirectURI).createAuthorizationURL(state, codeVerifier, ["openid", "email", "https://www.googleapis.com/auth/youtube.readonly"])`, redirect.
- `GET /youtube/callback` — exchange code, fetch identity (`GET https://www.googleapis.com/oauth2/v3/userinfo`, access-token-authenticated — same pattern as X's `/2/users/me` call, not id_token JWT-decoding), upsert `YOUTUBE_ACCOUNT` row with `sync_status: "pending"`, redirect immediately, then in `c.executionCtx.waitUntil(...)`: paginate `subscriptions.list?mine=true&part=snippet&maxResults=50` to completion, write `config.subscriptions`/`sync_status: "done"` (or `"error"`). Backgrounding this removes any need for token-refresh handling — the token's only use is inside this one task, right after minting.

**`link/src/routes-channels.ts`**, replacing the current `--- YouTube ---` section:
- `GET /youtube/status` → `{connected, email, sync_status, subscription_count, created_at}`.
- `GET /youtube/subscriptions` → the cached list, each annotated `already_watching: boolean` against the tenant's existing `YOUTUBE` rows.
- `POST /youtube/subscriptions/:youtubeChannelId/watch` → looks up name/thumbnail from the cached list (no extra Data API call needed — `subscriptions.list` already returns them), then calls a **shared find-or-create-and-subscribe helper extracted from the current `POST /youtube/watch` handler** (same tenant-scoped upsert, same `subscribeWebSub`-only-on-first-creation logic) — the URL-resolution step is deleted, but the channel-row/WebSub logic is reused, not duplicated.
- `DELETE /:type` (existing generic route) handles `YOUTUBE_ACCOUNT` disconnect as-is.

**Pre-requisite fix**: `GET /` (the generic channel-list route the Inspector dropdown calls) does `channel_type IN (?, 'TWITTER')` unconditionally — a legacy X/TWITTER migration alias. Calling it with `type=YOUTUBE` currently becomes `IN ('YOUTUBE','TWITTER')`, leaking a tenant's legacy TWITTER row into the YouTube dropdown. Scope that alias to `type === 'X'` only before the Inspector rework depends on this route.

## Frontend

- **`link/frontend/components/SocialChannels.tsx`**: new `YouTubeAccountCard` (bespoke, like `XChannelCard` — not added to the generic `SIMPLE_CHANNELS` registry since it needs more than connect/disconnect). "Connect YouTube" → `/api/auth/youtube/connect`. When connected: a subscription picker (list from `GET /channels/youtube/subscriptions`, per-item "Watch"/"Watching" button calling the new watch-selection endpoint), with a "syncing…" state polling `GET /channels/youtube/status` while `sync_status === "pending"`.
- **`flow/frontend/components/Inspector.tsx`**: `YouTubeContentTriggerInspector` drops the URL input/Watch button, becomes a `<Select>` dropdown fed by `api.channels.list("YOUTUBE")` — mirrors `XContentTriggerInspector`'s existing "Account" dropdown exactly.
- **`flow/frontend/lib/api.ts`**: delete `channels.youtubeWatch`.
- **`flow/src/index.ts`**: delete the `POST /api/channels/youtube/watch` proxy — the new picker UI lives entirely in `link`'s own frontend, nothing in `flow` needs to reach it.
- **`flow/nodeTypeRegistry.ts`** / **`flow/frontend/store/flow-editor.ts`**: default node data drops `channelUrl` → `{ channelId: "", channelName: "", conditions: [] }`; `promptFragment` wording updated to describe picking from a dropdown.
- **`flow/frontend/nodes/YouTubeContentTriggerNode.tsx`**: confirm it doesn't render `channelUrl` anywhere; if it does, switch to `channelName`.

## Env / `wrangler.toml`

- `link/src/types.ts` `Env`: add `YOUTUBE_OAUTH_CLIENT_ID: string`, `YOUTUBE_OAUTH_CLIENT_SECRET: string` (distinct from `YOUTUBE_API_KEY`). Add `"YOUTUBE_ACCOUNT"` to `ChannelType`.
- `link/wrangler.toml`: `YOUTUBE_OAUTH_CLIENT_ID` in `[env.dev.vars]`/`[env.production.vars]` (plaintext, like `X_CLIENT_ID`). `YOUTUBE_OAUTH_CLIENT_SECRET` via `wrangler secret put` (manual step, alongside creating the actual Google Cloud OAuth client — out of scope for code).
- Redirect URI: `/api/auth/youtube/callback`, matching the `/x/callback` / `/tiktok/callback` convention.

## Deleted (dead after this change)

`POST /youtube/watch`, `resolveYouTubeChannelId`, `fetchChannelByHandle`, `runChannelLookup`, `fetchChannelSnippet` (all only reachable from the deleted route — `ingestYouTubeVideo` uses `fetchVideoDetails`/`parseISO8601Duration`, neither of which is touched), and the old route's tests in `link/tests/routes-channels-youtube.test.ts`.

## Risks (flagged, not solved here)

- **Google app verification**: `youtube.readonly` is a Google-classified sensitive scope. An unverified OAuth client caps at ~100 total users and shows an "unverified app" warning to every connecting tenant until Google completes verification review (requires a privacy policy URL, homepage, demo video — real lead time). This should be scheduled as a parallel ops task, not discovered after shipping.
- Large-subscription-count accounts: unbounded pagination inside one `waitUntil` background task could run long for an account with thousands of subscriptions. Accepted v1 tradeoff, flagged for later if it becomes a real problem.

## Testing

Unit tests for: the TWITTER-alias-leak fix, `fetchYouTubeUserInfo`/paginated `fetchAllSubscriptions` (mocked fetch), OAuth connect/callback (mocked token exchange), the background sync task (extracted as a named, independently-callable function — not raced via `waitUntil`), `GET /youtube/status`/`GET /youtube/subscriptions` (seeded rows, `already_watching` annotation), the shared find-or-create-and-subscribe helper (idempotent on repeat calls), and — explicitly — that disconnecting `YOUTUBE_ACCOUNT` never touches `YOUTUBE` rows or calls `unsubscribeWebSub`.
