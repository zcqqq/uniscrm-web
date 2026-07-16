-- Prevents concurrent refreshAccessToken calls (e.g. cron's hourly proactive
-- refresh racing a poller's reactive 401-retry) from both submitting the same
-- single-use refresh token to the provider at once. X/TikTok rotate refresh
-- tokens and can revoke the entire token lineage on detecting reuse, which
-- otherwise permanently breaks the channel until the user reconnects it.
ALTER TABLE channels ADD COLUMN token_refresh_lock_until TEXT;
