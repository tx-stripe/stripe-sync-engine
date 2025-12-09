-- Add closed_at column to _sync_run
-- closed_at IS NULL means the run is still active
-- Status is derived from object states when closed_at IS NOT NULL

-- Step 1: Drop dependent view first
DROP VIEW IF EXISTS "stripe"."sync_dashboard";

-- Step 2: Drop the old constraint and status column
ALTER TABLE "stripe"."_sync_run" DROP CONSTRAINT IF EXISTS one_active_run_per_account;
ALTER TABLE "stripe"."_sync_run" DROP COLUMN IF EXISTS status;

-- Step 3: Add closed_at column
ALTER TABLE "stripe"."_sync_run" ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Step 4: Create exclusion constraint (only one active run per account)
ALTER TABLE "stripe"."_sync_run"
ADD CONSTRAINT one_active_run_per_account
EXCLUDE ("_account_id" WITH =) WHERE (closed_at IS NULL);

-- Step 5: Recreate sync_dashboard view (run-level only, one row per run)
CREATE OR REPLACE VIEW "stripe"."sync_dashboard" AS
SELECT
  r."_account_id" as account_id,
  r.started_at,
  r.completed_at,
  r.closed_at,
  r.max_concurrent,
  r.triggered_by,
  r.updated_at,
  -- Derived status
  CASE
    WHEN r.closed_at IS NULL THEN 'running'
    WHEN EXISTS (
      SELECT 1 FROM "stripe"."_sync_obj_run" o
      WHERE o."_account_id" = r."_account_id"
        AND o.run_started_at = r.started_at
        AND o.status = 'error'
    ) THEN 'error'
    ELSE 'complete'
  END as status,
  -- First error message from failed objects
  (SELECT o.error_message FROM "stripe"."_sync_obj_run" o
   WHERE o."_account_id" = r."_account_id" AND o.run_started_at = r.started_at AND o.status = 'error'
   ORDER BY o.object LIMIT 1) as error_message,
  -- Total processed count across all objects
  COALESCE((SELECT SUM(o.processed_count) FROM "stripe"."_sync_obj_run" o
   WHERE o."_account_id" = r."_account_id" AND o.run_started_at = r.started_at), 0) as processed_count
FROM "stripe"."_sync_run" r;
