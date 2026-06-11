-- Create tenants table
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

-- Create members table
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT UNIQUE NOT NULL,
  preferred_location TEXT DEFAULT 'global',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_members_tenant ON members(tenant_id);

-- Backfill: create a tenant per existing user (1:1, tenant.id = user.id)
INSERT INTO tenants (id, email, created_at)
SELECT id, email, created_at FROM users;

-- Copy users → members with tenant_id = their own id
INSERT INTO members (id, tenant_id, email, preferred_location, created_at)
SELECT id, id, email, preferred_location, created_at FROM users;

-- Keep users table for FK compatibility (contents, content_items reference it)
-- Code now queries members table exclusively
