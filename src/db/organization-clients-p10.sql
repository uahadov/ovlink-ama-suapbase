-- P10: logical agency client spaces. Never remove legacy UNIQUE(owner_user_id)
-- or reparent existing link redirects; no customer data migration.
BEGIN;
CREATE TABLE IF NOT EXISTS organization_client_spaces (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 2 AND 100),
 contact_encrypted TEXT,
 contact_hash TEXT,
 logo_url TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 report_settings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(report_settings)='object'),
 created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 archived_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_client_spaces ON organization_client_spaces(organization_id,status,created_at);
CREATE TABLE IF NOT EXISTS organization_client_members (
 client_id UUID NOT NULL REFERENCES organization_client_spaces(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(client_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_client_members_user ON organization_client_members(user_id);
CREATE TABLE IF NOT EXISTS organization_client_campaigns (
 client_id UUID NOT NULL REFERENCES organization_client_spaces(id) ON DELETE CASCADE,
 campaign_id INTEGER PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
 linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_client_campaigns_client ON organization_client_campaigns(client_id);
COMMIT;
