-- P11 additive, idempotent business audit log upgrade (PostgreSQL 16).
-- Separates structured business operational audit from analytics access logs.
-- Gated behind ENABLE_ORGANIZATION_AUDIT_V1=1 (requires P07+P08+P09+P10).
BEGIN;

DO $audit_p11$
BEGIN
  IF to_regclass('public.organization_audit_log') IS NULL THEN
    RAISE EXCEPTION 'P11 requires P07 organization_audit_log';
  END IF;

  ALTER TABLE public.organization_audit_log
    ADD COLUMN IF NOT EXISTS action TEXT,
    ADD COLUMN IF NOT EXISTS resource_type TEXT,
    ADD COLUMN IF NOT EXISTS resource_id TEXT,
    ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES public.workspaces(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS request_id TEXT,
    ADD COLUMN IF NOT EXISTS result TEXT NOT NULL DEFAULT 'success',
    ADD COLUMN IF NOT EXISTS summary_json JSONB NOT NULL DEFAULT '{}'::jsonb;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organization_audit_log'::regclass
       AND conname = 'organization_audit_log_result_check'
  ) THEN
    ALTER TABLE public.organization_audit_log
      ADD CONSTRAINT organization_audit_log_result_check
      CHECK (result IN ('success', 'denied', 'failed'));
  END IF;

  UPDATE public.organization_audit_log
     SET action = COALESCE(NULLIF(metadata_json->>'kind', ''), event_key),
         summary_json = CASE WHEN summary_json = '{}'::jsonb AND metadata_json <> '{}'::jsonb THEN metadata_json ELSE summary_json END
   WHERE action IS NULL;
END
$audit_p11$;

CREATE INDEX IF NOT EXISTS idx_org_audit_org_created
  ON public.organization_audit_log(organization_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_org_audit_org_action
  ON public.organization_audit_log(organization_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_audit_org_actor
  ON public.organization_audit_log(organization_id, actor_user_id, created_at DESC);

COMMIT;
