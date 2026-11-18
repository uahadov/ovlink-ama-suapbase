-- P07 experimental additive migration, PostgreSQL 16. NOT APPLIED TO PRODUCTION.
-- Must be executed only against a disposable P03-style QA snapshot.
-- This is intentionally NOT wired into src/db/migrate.js while P05/P06 gates are open.
-- Running twice is idempotent, existing users/workspaces/campaigns/urls unchanged.
BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 100),
    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    legacy_workspace_id INTEGER UNIQUE REFERENCES workspaces(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_user_id);

CREATE TABLE IF NOT EXISTS organization_members (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

CREATE TABLE IF NOT EXISTS organization_workspaces (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_org_workspaces_org ON organization_workspaces(organization_id);

CREATE TABLE IF NOT EXISTS organization_settings (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    settings_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings_json)='object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Legacy subscriptions still live on the user; no charge or provider mutation.
-- A future approved billing stage must decide how the provider customer is moved.
CREATE TABLE IF NOT EXISTS organization_billing (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    billing_owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    billing_mode TEXT NOT NULL DEFAULT 'legacy_user_pro'
       CHECK (billing_mode IN ('legacy_user_pro','organization_subscription')),
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (billing_mode <> 'legacy_user_pro' OR
           (provider_customer_id IS NULL AND provider_subscription_id IS NULL))
);

CREATE TABLE IF NOT EXISTS organization_audit_log (
    id BIGSERIAL PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, event_key)
);

-- Existing workspace is the stable semantic source for legacy organization.
-- Once inserted, organization UUID never changes; replay is safe.
INSERT INTO organizations (display_name, owner_user_id, legacy_workspace_id)
SELECT w.name, w.owner_user_id, w.id
FROM workspaces AS w
ON CONFLICT (legacy_workspace_id) DO NOTHING;

INSERT INTO organization_workspaces (organization_id,workspace_id)
SELECT o.id, w.id
FROM workspaces w
JOIN organizations o ON o.legacy_workspace_id = w.id
ON CONFLICT (workspace_id) DO NOTHING;

-- Preserve existing membership roles. Owner must also be present even if
-- legacy membership row is missing; conflict on same org/user not overwritten.
INSERT INTO organization_members (organization_id,user_id,role)
SELECT o.id, wm.user_id,
   CASE WHEN wm.user_id = o.owner_user_id THEN 'owner'
        WHEN wm.role IN ('owner','admin','member') THEN wm.role
        ELSE 'member' END
FROM organizations o
JOIN workspace_members wm ON wm.workspace_id = o.legacy_workspace_id
ON CONFLICT (organization_id,user_id) DO NOTHING;

INSERT INTO organization_members (organization_id,user_id,role)
SELECT id, owner_user_id, 'owner'
FROM organizations
ON CONFLICT (organization_id,user_id) DO UPDATE
SET role='owner'
WHERE organization_members.role <> 'owner';

INSERT INTO organization_settings (organization_id)
SELECT id FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO organization_billing (organization_id,billing_owner_user_id)
SELECT id,owner_user_id FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO organization_audit_log (organization_id,event_key,actor_user_id,metadata_json)
SELECT id,'p07_legacy_backfill_v1',owner_user_id,
       jsonb_build_object('legacy_workspace_id',legacy_workspace_id,'kind','automatic_backfill')
FROM organizations
WHERE legacy_workspace_id IS NOT NULL
ON CONFLICT (organization_id,event_key) DO NOTHING;

COMMIT;
