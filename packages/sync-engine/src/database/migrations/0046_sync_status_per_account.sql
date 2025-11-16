-- Add _account_id to _sync_status table to track sync cursors per account
-- This enables proper cursor isolation when syncing multiple Stripe accounts
--
-- Breaking change: All existing cursor data will be deleted (clean slate)
-- Next sync will perform a full backfill for each account

-- Step 1: Delete all existing cursor data
DELETE FROM "stripe"."_sync_status";

-- Step 2: Add _account_id column
ALTER TABLE "stripe"."_sync_status" ADD COLUMN "_account_id" TEXT NOT NULL;

-- Step 3: Drop existing unique constraint on resource
ALTER TABLE "stripe"."_sync_status" DROP CONSTRAINT IF EXISTS _sync_status_resource_key;

-- Step 4: Add new composite unique constraint on (resource, _account_id)
ALTER TABLE "stripe"."_sync_status"
  ADD CONSTRAINT _sync_status_resource_account_key
  UNIQUE (resource, "_account_id");

-- Step 5: Add index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_sync_status_resource_account
  ON "stripe"."_sync_status" (resource, "_account_id");
