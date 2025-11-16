#!/usr/bin/env tsx

/**
 * Test helper script for dangerouslyDeleteAccount() method.
 * This is NOT exposed as a CLI command due to safety concerns.
 * Used only for integration testing.
 */

import dotenv from 'dotenv'
import { type PoolConfig } from 'pg'
import { StripeSync } from 'stripe-replit-sync'

dotenv.config()

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.error('Usage: tsx scripts/test-delete-account.ts <accountId> [--dry-run] [--no-transaction]')
    process.exit(1)
  }

  const accountId = args[0]
  const dryRun = args.includes('--dry-run')
  const useTransaction = !args.includes('--no-transaction')

  const databaseUrl = process.env.DATABASE_URL || ''
  const schema = process.env.SCHEMA || 'stripe'

  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const poolConfig: PoolConfig = {
    max: 10,
    connectionString: databaseUrl,
    keepAlive: true,
  }

  const stripeSync = new StripeSync({
    databaseUrl,
    schema,
    stripeSecretKey: 'sk_test_placeholder', // Not needed for deletion
    stripeApiVersion: '2020-08-27',
    poolConfig,
  })

  try {
    const result = await stripeSync.dangerouslyDeleteAccount(accountId, {
      dryRun,
      useTransaction,
    })

    // Output as JSON for easy parsing in bash scripts
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

main()
