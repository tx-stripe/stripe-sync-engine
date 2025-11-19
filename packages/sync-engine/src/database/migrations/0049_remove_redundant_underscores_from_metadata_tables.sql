-- Remove redundant underscore prefixes from columns in metadata tables
--
-- For tables that are already prefixed with underscore (indicating they are
-- metadata/system tables), the underscore prefix on columns is redundant.
-- This migration removes those redundant prefixes to keep naming cleaner.
--
-- Affected tables: _sync_status, _managed_webhooks

-- Update _sync_status table
-- Step 1: Drop constraints that reference the old column names
ALTER TABLE "stripe"."_sync_status" DROP CONSTRAINT IF EXISTS _sync_status_resource_account_key;
ALTER TABLE "stripe"."_sync_status" DROP CONSTRAINT IF EXISTS fk_sync_status_account;
DROP INDEX IF EXISTS "stripe"."idx_sync_status_resource_account";

-- Step 2: Rename columns
ALTER TABLE "stripe"."_sync_status" RENAME COLUMN "_id" TO "id";
ALTER TABLE "stripe"."_sync_status" RENAME COLUMN "_last_synced_at" TO "last_synced_at";
ALTER TABLE "stripe"."_sync_status" RENAME COLUMN "_updated_at" TO "updated_at";
ALTER TABLE "stripe"."_sync_status" RENAME COLUMN "_account_id" TO "account_id";

-- Step 3: Recreate constraints with new column names
ALTER TABLE "stripe"."_sync_status"
  ADD CONSTRAINT _sync_status_resource_account_key
  UNIQUE (resource, "account_id");

CREATE INDEX IF NOT EXISTS idx_sync_status_resource_account
  ON "stripe"."_sync_status" (resource, "account_id");

ALTER TABLE "stripe"."_sync_status"
  ADD CONSTRAINT fk_sync_status_account
  FOREIGN KEY ("account_id") REFERENCES "stripe"."accounts" (id);

-- Update _managed_webhooks table
-- Step 1: Drop constraints that reference the old column names
ALTER TABLE "stripe"."_managed_webhooks" DROP CONSTRAINT IF EXISTS fk_managed_webhooks_account;

-- Step 2: Rename columns
ALTER TABLE "stripe"."_managed_webhooks" RENAME COLUMN "_id" TO "id";
ALTER TABLE "stripe"."_managed_webhooks" RENAME COLUMN "_last_synced_at" TO "last_synced_at";
ALTER TABLE "stripe"."_managed_webhooks" RENAME COLUMN "_updated_at" TO "updated_at";
ALTER TABLE "stripe"."_managed_webhooks" RENAME COLUMN "_account_id" TO "account_id";

-- Step 3: Recreate foreign key constraint with new column name
ALTER TABLE "stripe"."_managed_webhooks"
  ADD CONSTRAINT fk_managed_webhooks_account
  FOREIGN KEY ("account_id") REFERENCES "stripe"."accounts" (id);
