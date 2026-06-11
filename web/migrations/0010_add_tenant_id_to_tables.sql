-- Add tenant_id columns (DEFAULT '' for existing rows, then backfill)
ALTER TABLE oauth_accounts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE contents ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE event_x ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_x ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';

-- Backfill oauth_accounts via members table (user_id = member UUID)
UPDATE oauth_accounts SET tenant_id = (
  SELECT tenant_id FROM members WHERE members.id = oauth_accounts.user_id
) WHERE EXISTS (SELECT 1 FROM members WHERE members.id = oauth_accounts.user_id);

-- Backfill contents via members table (user_id = member UUID)
UPDATE contents SET tenant_id = (
  SELECT tenant_id FROM members WHERE members.id = contents.user_id
) WHERE EXISTS (SELECT 1 FROM members WHERE members.id = contents.user_id);

-- Backfill event_x via channel_configs → members (user_id here is X platform ID, not member)
UPDATE event_x SET tenant_id = (
  SELECT m.tenant_id FROM channel_configs cc
  JOIN members m ON m.id = cc.user_id
  WHERE cc.id = event_x.channel_id
) WHERE EXISTS (
  SELECT 1 FROM channel_configs cc WHERE cc.id = event_x.channel_id
);

-- Backfill user_x via event_x (user_x.id = X platform user ID, link through event_x)
UPDATE user_x SET tenant_id = (
  SELECT DISTINCT e.tenant_id FROM event_x e WHERE e.user_id = user_x.id LIMIT 1
) WHERE EXISTS (SELECT 1 FROM event_x e WHERE e.user_id = user_x.id);

-- Indexes for tenant isolation queries
CREATE INDEX idx_oauth_accounts_tenant ON oauth_accounts(tenant_id);
CREATE INDEX idx_contents_tenant ON contents(tenant_id);
CREATE INDEX idx_event_x_tenant ON event_x(tenant_id);
CREATE INDEX idx_user_x_tenant ON user_x(tenant_id);
