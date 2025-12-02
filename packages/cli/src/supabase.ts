import { SupabaseManagementAPI } from 'supabase-management-js'

// Edge Function: Webhook handler
// Uses Supabase's built-in SUPABASE_DB_URL - no password needed!
export const WEBHOOK_FUNCTION_CODE = `
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { StripeSync } from 'npm:@supabase/stripe-sync-engine'

const stripeSync = new StripeSync({
  poolConfig: { connectionString: Deno.env.get('SUPABASE_DB_URL')!, max: 5 },
  stripeWebhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  const rawBody = new Uint8Array(await req.arrayBuffer())
  await stripeSync.processWebhook(rawBody, req.headers.get('stripe-signature'))
  return new Response(null, { status: 202 })
})
`.trim()

// Edge Function: Backfill worker
// Uses Supabase's built-in SUPABASE_DB_URL - no password needed!
export const WORKER_FUNCTION_CODE = `
import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { StripeSync } from 'npm:@supabase/stripe-sync-engine'

const stripeSync = new StripeSync({
  poolConfig: { connectionString: Deno.env.get('SUPABASE_DB_URL')!, max: 5 },
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  // Process one page of each object type that has pending work
  // Uses _sync_runs table to track progress
  const results = await stripeSync.processNext()

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
})
`.trim()

export interface SupabaseProject {
  id: string
  ref: string
  name: string
  region: string
  database: {
    host: string
    version: string
  }
}

export class SupabaseDeployClient {
  private api: SupabaseManagementAPI
  private projectRef: string
  private accessToken: string

  constructor(accessToken: string, projectRef: string) {
    this.accessToken = accessToken
    this.projectRef = projectRef
    this.api = new SupabaseManagementAPI({ accessToken })
  }

  /**
   * Get project info to validate access and get database connection details
   */
  async getProject(): Promise<SupabaseProject> {
    const project = await this.api.getProject(this.projectRef)
    if (!project) {
      throw new Error(`Project ${this.projectRef} not found or access denied`)
    }
    return project as SupabaseProject
  }

  /**
   * Run SQL against the project database
   */
  async runSQL(sql: string): Promise<unknown> {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${this.projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      }
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`SQL execution failed: ${error}`)
    }

    return response.json()
  }

  /**
   * Run migrations via the Management API SQL endpoint.
   * This tracks completed migrations in stripe._migrations table.
   */
  async runMigrations(
    migrations: Array<{ name: string; sql: string }>
  ): Promise<{ applied: string[]; skipped: string[] }> {
    const applied: string[] = []
    const skipped: string[] = []

    // Create schema and migrations table if they don't exist
    await this.runSQL(`
      CREATE SCHEMA IF NOT EXISTS stripe;
      CREATE TABLE IF NOT EXISTS stripe._migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `)

    // Get already applied migrations
    const result = (await this.runSQL(
      `SELECT name FROM stripe._migrations ORDER BY name`
    )) as Array<{ name: string }>
    const appliedSet = new Set(result.map((r) => r.name))

    // Apply each migration in order
    for (const migration of migrations) {
      if (appliedSet.has(migration.name)) {
        skipped.push(migration.name)
        continue
      }

      // Run migration and record it
      await this.runSQL(migration.sql)
      await this.runSQL(`INSERT INTO stripe._migrations (name) VALUES ('${migration.name}')`)
      applied.push(migration.name)
    }

    return { applied, skipped }
  }

  /**
   * Deploy an Edge Function
   */
  async deployEdgeFunction(slug: string, code: string): Promise<void> {
    const formData = new FormData()

    // Add metadata
    formData.append(
      'metadata',
      JSON.stringify({
        entrypoint_path: 'index.ts',
        name: slug,
      })
    )

    // Add the source file
    const blob = new Blob([code], { type: 'application/typescript' })
    formData.append('file', blob, 'index.ts')

    const response = await fetch(
      `https://api.supabase.com/v1/projects/${this.projectRef}/functions/deploy?slug=${slug}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: formData,
      }
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Edge Function deployment failed: ${error}`)
    }
  }

  /**
   * Set secrets for Edge Functions
   */
  async setSecrets(secrets: Record<string, string>): Promise<void> {
    const secretsArray = Object.entries(secrets).map(([name, value]) => ({
      name,
      value,
    }))

    const response = await fetch(
      `https://api.supabase.com/v1/projects/${this.projectRef}/secrets`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(secretsArray),
      }
    )

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Setting secrets failed: ${error}`)
    }
  }

  /**
   * Set up pg_cron job to trigger the worker every 10 seconds
   */
  async setupCronJob(): Promise<void> {
    const cronSQL = `
      -- Enable required extensions
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE EXTENSION IF NOT EXISTS pg_net;

      -- Remove existing job if present
      SELECT cron.unschedule('stripe-sync-worker')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker');

      -- Schedule worker to run every 10 seconds
      SELECT cron.schedule(
        'stripe-sync-worker',
        '10 seconds',
        $$
        SELECT net.http_post(
          url := 'https://${this.projectRef}.supabase.co/functions/v1/stripe-worker',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('supabase.service_role_key', true)
          )
        )
        $$
      );
    `

    await this.runSQL(cronSQL)
  }

  /**
   * Get the database connection string for the project
   */
  getDatabaseUrl(project: SupabaseProject, dbPassword: string): string {
    return `postgresql://postgres:${dbPassword}@db.${this.projectRef}.supabase.co:5432/postgres`
  }

  /**
   * Get the webhook URL for the project
   */
  getWebhookUrl(): string {
    return `https://${this.projectRef}.supabase.co/functions/v1/stripe-webhook`
  }

  /**
   * Get the worker URL for the project
   */
  getWorkerUrl(): string {
    return `https://${this.projectRef}.supabase.co/functions/v1/stripe-worker`
  }
}
