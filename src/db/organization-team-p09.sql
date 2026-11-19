-- P09 isolated, additive, default-OFF organization team lifecycle.
BEGIN;
CREATE TABLE IF NOT EXISTS organization_invitations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 email_hash TEXT NOT NULL,
 email_encrypted TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('admin','manager','analyst','client_viewer')),
 invited_by_user_id INTEGER NOT NULL REFERENCES users(id),
 expires_at TIMESTAMPTZ NOT NULL,
 accepted_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_org_invites_scope ON organization_invitations(organization_id,email_hash);
CREATE INDEX IF NOT EXISTS idx_org_invites_expires ON organization_invitations(expires_at);
COMMIT;
