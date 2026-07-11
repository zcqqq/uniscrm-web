# X-BYOK Followers Polling Design

## Context

`link` currently learns about a channel's X followers/following only via real-time XAA webhook events (`follow.follow`, `follow.followed`, etc., defined in `metadata/x.ts`). This misses two things: (1) the full historical follower list at the time a channel connects, and (2) any follow events X failed to deliver as a webhook.

This feature adds polling: on BYOK channel creation (or reactivation, `is_active` 0→1), paginate through X's `get-followers` endpoint to backfill the full follower list; after backfill, poll hourly to catch drift.

**Scoped to BYOK only.** The system-default X app's rate limit is shared across every tenant on it; per-tenant polling against that shared quota isn't viable. BYOK channels have their own dedicated X app credentials and quota, so only channels with `config.is_byok === true` are polled. This is a plain runtime check, not a metadata distinction — `channel_type` stays `'X'` for both, matching the existing BYOK design (crypto-decrypted credentials via `getAppCredentials`, shared webhook/OAuth code paths).

This is the first of what will likely become several polling endpoints (for X and other channel types), so the plumbing (poller registry, poll-state storage) is built to extend, even though only one poller is implemented now.

## Non-goals

- Polling for the system-default X app (out of scope; shared-quota problem needs separate design if ever needed).
- Any channel type other than X.
- Reconciling `raw_data` shape between webhook-sourced and poll-sourced user records — they're allowed to differ; each source stores whatever it captured.

## Metadata

`metadata/x-byok.ts` (existing draft, kept as an intentionally self-contained file — no import from `metadata/x.ts`) gets one addition: a static `is_followed: 1` prop on the `get-followers` entry, since everyone returned by that endpoint is, by definition, a follower.

```ts
export const UserMetadata_X_BYOK: UserMetadata[] = [
  {
    sourceUserType: "get-followers", // https://docs.x.com/x-api/users/get-followers
    linkPrefix: "data[]",
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 1 },
    ],
  },
];
```

`followers_count` is deliberately left unmapped for now — the endpoint returns `verified_followers_count`, which may not be equivalent to the `followers_count` insight prop used elsewhere; needs verification before mapping. Per the existing convention, a prop with no resolved value is simply omitted from the write, never defaulted — so leaving it out has no correctness impact, only means this endpoint doesn't (yet) refresh that field.

`metadata/index.ts` gets `UserMetadata` type and `UserMetadata_X_BYOK` added to its exports.

## Poll state storage

New table, provisioned in `link/migrations/`:

```sql
CREATE TABLE channel_poll_state (
  channel_id TEXT NOT NULL,
  poller_name TEXT NOT NULL,
  cursor TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0,
  last_polled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, poller_name)
);
```

Rejected alternative: storing poll state inside `channels.config` JSON (where `subscription_ids`, `x_user_id` etc. already live). Rejected because every additional poller would grow that blob further, and every poller write would be a read-modify-write of the *entire* config, racing against unrelated writers (e.g. token refresh). A dedicated table gives each poller its own row, keyed by `(channel_id, poller_name)`, with no cross-poller or cross-writer contention.

A row is created (or `backfill_complete` reset to `0`, `cursor` cleared) whenever a BYOK X channel is created or reactivated (`is_active` 0→1).

## Poller registry

`link/src/services/pollers/index.ts` — a small map keyed by `channel_type`, so future channel types/pollers plug in without touching `cron.ts`:

```ts
interface Poller {
  name: string; // matches poller_name in channel_poll_state
  run(ctx: PollerContext): Promise<void>;
}

export const POLLERS: Record<string, Poller[]> = {
  X: [followersPoller],
};
```

`PollerContext` carries the channel row, resolved credentials (via `getAppCredentials`), a `TenantDataDB` handle, `PIPELINE_USER`, and a `deadline` timestamp (see budget below).

## Cron integration

`link/src/cron.ts`: `handleCron` gains a new step, run alongside the existing two via `Promise.allSettled`:

```ts
export async function handleCron(env: Env): Promise<void> {
  await Promise.allSettled([
    handleTrendAggregation(env),
    handleTokenRefresh(env),
    handlePolling(env),
  ]);
}
```

`handlePolling`:
1. `SELECT id, config, tenant_id FROM channels WHERE channel_type = 'X' AND is_active = 1`.
2. Filter to `config.is_byok === true`.
3. For each channel, for each poller registered under `X`: check `channel_poll_state` — skip if `backfill_complete = 1` and `last_polled_at` is within the last hour (guards against overlapping cron runs; the trigger itself is already hourly).
4. Run the poller with a per-channel time budget (proposed: 20s), shared cron-wide budget enforced by simply stopping the whole `handlePolling` loop once total elapsed time crosses a ceiling (proposed: 50s), so one very large account can't starve every other channel's poll turn for the run.

## Followers poller (`link/src/services/pollers/x-followers.ts`)

**Backfill phase** (`backfill_complete = 0`):
- `GET /2/users/:id/followers?pagination_token=<cursor>&max_results=1000&user.fields=...` (fields limited to what `UserMetadata_X_BYOK` + raw storage need).
- For each item in `data[]`: resolve `UserMetadata_X_BYOK` userProps against it, upsert via the new metadata-aware method (below).
- Advance `cursor` to `meta.next_token`.
- Loop pages back-to-back within the same invocation until: no `next_token` (→ `backfill_complete = 1`, `cursor = NULL`), a 429 response, or the time budget is spent. Persist `cursor` and `updated_at` after every page (not just at the end), so a mid-run crash doesn't lose progress.

**Post-backfill phase** (`backfill_complete = 1`):
- Each hourly run starts over at page 1 (`cursor = NULL` for the request, not persisted state — X returns newest-first).
- Upsert each page; after a page, if it produced **zero new users** (every `source_user_id` in it already existed in `user`), stop — nothing further back is new.
- If a page has any new users, continue to the next page (covers a burst of new followers spanning a page boundary), still bounded by the same time budget / 429 handling as backfill.
- This is a reconciliation pass alongside the existing real-time webhook events, not a replacement — overlap between the two is expected and harmless (both go through the same non-destructive upsert).

## Metadata-driven upsert (fixes an existing inconsistency along the way)

New method on `XUsersService`, `upsertUserFromMetadata(rawItem, userProps, channelId, channelType)`:
- Resolves each `UserPropMapping` (either `dataId` navigated against `rawItem`, or a static `value`) — a prop with no resolved value is **omitted** from both the D1 `UPDATE` and the pipeline record, never defaulted.
- `raw_data` = `JSON.stringify(rawItem)` — the *entire* object at the resolved `linkPrefix` position, unfiltered, matching how `event.raw_data` already stores the full payload. No per-field curation.
- This is a new sibling method, not a rewrite of the existing `upsertUser`/`pickDbFields`/`flattenUserPayload` webhook path — those are untouched.

Bug fixed opportunistically since it's the same code area and the correctness issue is real: `upsertUser`'s current pipeline-record construction defaults every unresolved `isInsight` count prop to `0` (`pm?.[prop.propId] ?? 0`). If a webhook payload lacks e.g. `followers_count`, this silently zeroes out a previously-correct value in the pipeline record. Changed to omit the key instead, consistent with the "missing data never overwrites existing data" convention applied everywhere else in this design.

## Testing

- Unit tests for `UserMetadata_X_BYOK` prop resolution (dataId navigation + static value + omission-on-missing).
- Unit tests for `channel_poll_state` transitions: create → row seeded; reactivate → `backfill_complete` reset; backfill loop → cursor persists across simulated pages; 429 mid-backfill → cursor persisted, no `backfill_complete`; post-backfill zero-new-users page → loop stops.
- Integration-style test (mocked X API) for `handlePolling` end-to-end: BYOK channel gets polled, system-app X channel does not.
- Regression test for the `upsertUser` `?? 0` fix: existing `followers_count` must survive an upsert call whose payload lacks that field.
