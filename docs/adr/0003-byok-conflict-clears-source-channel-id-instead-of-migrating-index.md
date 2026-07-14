# 0003: X BYOK channel conflicts free the old row by clearing source_channel_id, not by migrating the unique index

## Status

Accepted

## Context

`channels` has `UNIQUE(channel_type, source_channel_id)`. The X BYOK OAuth
callback can discover, after the token exchange, that the X account being
authorized is already tied to a *different* `channels` row — a prior
system-app connection, or a duplicate BYOK placeholder from a double-click
on "Add App". The callback must free that slot before it can write
`source_channel_id` onto the row currently being authorized
(`byokChannelId`), or it hits the UNIQUE constraint (this was the original
production bug: `D1_ERROR: UNIQUE constraint failed: channels.channel_type,
channels.source_channel_id`).

Two designs were considered for freeing the slot:

1. **Clear `source_channel_id` to NULL on the old row** (chosen). SQLite
   never considers NULL to equal another NULL, so a NULL `source_channel_id`
   is permanently exempt from the unique index — no schema change needed.
2. **Add `is_active` to the unique index** (`channel_type, source_channel_id,
   is_active`), so a deactivated row no longer collides with an active one
   sharing the same account. Rejected: a single X account disconnected and
   reconnected multiple times (system-app → BYOK → disconnect → system-app
   again) accumulates multiple `is_active=0` rows that all share the same
   3-column tuple and collide with *each other*. It would also require a
   migration and require updating the system-app path's existing
   `INSERT ... ON CONFLICT(channel_type, source_channel_id)` to target the
   new index shape.

## Decision

On conflict, the old row is deactivated (`is_active = 0`), its
`source_channel_id` is cleared to `NULL`, and `deactivated_reason` is set to
`byok_merged source_channel_id=<id>` — distinct from the `'tier_limit'`
value used by tier-enforcement pauses (`admin/src/routes/webhook.ts`) so a
later tier upgrade's reactivation query (which filters on
`deactivated_reason = 'tier_limit'`) never touches it. The freed X account
id is still recoverable from this string and from the old row's `config`
JSON (`x_user_id`), even though the `source_channel_id` column itself is
now NULL.

## Consequences

- No migration required; the existing two-column unique index and the
  system-app path's `ON CONFLICT` target are both untouched.
- The old row's `source_channel_id` column can no longer be queried
  directly for its former X account — callers needing that must read
  `config.x_user_id` or parse `deactivated_reason` instead.
- Repeated disconnect/reconnect cycles for the same X account are safe:
  every deactivated row ends up with `source_channel_id = NULL`, which
  never collides, no matter how many accumulate.
