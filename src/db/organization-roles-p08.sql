-- P08 opt-in upgrade from the P07 organization model. NEVER run against production
-- until business gates, database backup, review and staged release are accepted.
-- P07's legacy backfill can still write member. It is deliberately retained in
-- storage for backwards compatibility but the P08 policy denies it on NEW orgs.
-- Legacy workspaces continue reading fresh workspace_members rows, not the shadow.
BEGIN;

DO $role_upgrade$
DECLARE old_def text;
BEGIN
  IF to_regclass('public.organization_members') IS NULL THEN
    RAISE EXCEPTION 'P08 requires P07 organization_members';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO old_def
    FROM pg_constraint WHERE conrelid='public.organization_members'::regclass
    AND conname='organization_members_role_check' AND contype='c';
  IF old_def IS NULL THEN
    RAISE EXCEPTION 'P08 unexpected role constraint (missing); refusing migration';
  END IF;
  -- Reject unexpected custom constraints instead of silently loosening them.
  IF old_def NOT LIKE '%role%' OR old_def NOT LIKE '%owner%' OR
     old_def NOT LIKE '%admin%' OR old_def NOT LIKE '%member%' THEN
    RAISE EXCEPTION 'P08 unexpected existing role check: %', old_def;
  END IF;
  ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
  ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
    CHECK (role IN ('owner','admin','manager','analyst','client_viewer','member'));
END
$role_upgrade$;

COMMIT;
