import { SupabaseManagementAPI } from 'supabase-management-js'

// Edge Function templates for Supabase deployment

// Import base - override with STRIPE_SYNC_IMPORT_BASE env var for testing
const IMPORT_BASE = process.env.STRIPE_SYNC_IMPORT_BASE || 'npm:stripe-replit-sync'

// Template function - projectRef will be replaced at deploy time
export function getSetupFunctionCode(projectRef: string): string {
  const importBase = IMPORT_BASE
  const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-webhook`
  return `import { StripeSync, runMigrations } from '${importBase}'
import { PostgresJsAdapter } from '${importBase}/postgres-js'

const WEBHOOK_URL = '${webhookUrl}'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const adapter = new PostgresJsAdapter({
      connectionString: Deno.env.get('SUPABASE_DB_URL')!,
      max: 1,
    })

    await runMigrations(adapter)

    const stripeSync = new StripeSync({
      adapter,
      stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
    })
    const webhook = await stripeSync.findOrCreateManagedWebhook(WEBHOOK_URL)

    await adapter.end()

    return new Response(JSON.stringify({
      success: true,
      message: 'Setup complete',
      webhookId: webhook.id,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Setup error:', error)
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export function getWebhookFunctionCode(): string {
  const importBase = IMPORT_BASE
  return `import { StripeSync } from '${importBase}'
import { PostgresJsAdapter } from '${importBase}/postgres-js'

const adapter = new PostgresJsAdapter({
  connectionString: Deno.env.get('SUPABASE_DB_URL')!,
  max: 5,
})

const stripeSync = new StripeSync({
  adapter,
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  try {
    const rawBody = new Uint8Array(await req.arrayBuffer())
    await stripeSync.processWebhook(rawBody, sig)
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook processing error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export function getWorkerFunctionCode(): string {
  const importBase = IMPORT_BASE
  return `import { StripeSync } from '${importBase}'
import { PostgresJsAdapter } from '${importBase}/postgres-js'

const adapter = new PostgresJsAdapter({
  connectionString: Deno.env.get('SUPABASE_DB_URL')!,
  max: 5,
})

const stripeSync = new StripeSync({
  adapter,
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  // Verify authorization (service role key from pg_cron)
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    // Process next batch of pending sync work
    const results = await stripeSync.processNext()
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Worker error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
`
}

export interface DeployClientOptions {
  accessToken: string
  projectRef: string
}

export interface ProjectInfo {
  id: string
  name: string
  region: string
}

export class SupabaseDeployClient {
  private api: SupabaseManagementAPI
  private projectRef: string
  private projectInfo: ProjectInfo | null = null

  constructor(options: DeployClientOptions) {
    this.api = new SupabaseManagementAPI({ accessToken: options.accessToken })
    this.projectRef = options.projectRef
  }

  /**
   * Validate project access by fetching project details
   */
  async validateProject(): Promise<ProjectInfo> {
    const projects = await this.api.getProjects()
    const project = projects?.find((p) => p.id === this.projectRef)
    if (!project) {
      throw new Error(`Project ${this.projectRef} not found or access denied`)
    }
    this.projectInfo = {
      id: project.id,
      name: project.name,
      region: project.region,
    }
    return this.projectInfo
  }

  /**
   * Construct the database URL from project info and password
   * Uses the Supabase pooler (session mode) for IPv4 compatibility and prepared statement support
   */
  getDatabaseUrl(password: string): string {
    if (!this.projectInfo) {
      throw new Error('Project info not available. Call validateProject() first.')
    }
    // Supabase pooler URL format (session mode - port 5432):
    // postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-1-[REGION].pooler.supabase.com:5432/postgres
    const encodedPassword = encodeURIComponent(password)
    return `postgresql://postgres.${this.projectRef}:${encodedPassword}@aws-1-${this.projectInfo.region}.pooler.supabase.com:5432/postgres`
  }

  /**
   * Deploy an Edge Function
   */
  async deployFunction(name: string, code: string): Promise<void> {
    // The supabase-management-js library handles function deployment
    // We need to create the function if it doesn't exist, or update it
    const functions = await this.api.listFunctions(this.projectRef)
    const existingFunction = functions?.find((f) => f.slug === name)

    if (existingFunction) {
      await this.api.updateFunction(this.projectRef, name, {
        body: code,
        verify_jwt: false, // Stripe webhooks don't use JWT
      })
    } else {
      await this.api.createFunction(this.projectRef, {
        slug: name,
        name: name,
        body: code,
        verify_jwt: false,
      })
    }
  }

  /**
   * Set secrets for the project
   */
  async setSecrets(secrets: Record<string, string>): Promise<void> {
    const secretsArray = Object.entries(secrets).map(([name, value]) => ({
      name,
      value,
    }))
    await this.api.createSecrets(this.projectRef, secretsArray)
  }

  /**
   * Run SQL query via Management API
   */
  async runSQL(sql: string): Promise<unknown> {
    return await this.api.runQuery(this.projectRef, sql)
  }

  /**
   * Setup pg_cron job to invoke worker function
   */
  async setupPgCronJob(): Promise<void> {
    const sql = `
      -- Enable pg_cron and pg_net extensions if not already enabled
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      CREATE EXTENSION IF NOT EXISTS pg_net;

      -- Delete existing job if it exists
      SELECT cron.unschedule('stripe-sync-worker') WHERE EXISTS (
        SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker'
      );

      -- Create job to invoke worker every 10 seconds
      SELECT cron.schedule(
        'stripe-sync-worker',
        '10 seconds',
        $$
        SELECT net.http_post(
          url := 'https://${this.projectRef}.supabase.co/functions/v1/stripe-worker',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
          )
        )
        $$
      );
    `
    await this.runSQL(sql)
  }

  /**
   * Get the webhook URL for this project
   */
  getWebhookUrl(): string {
    return `https://${this.projectRef}.supabase.co/functions/v1/stripe-webhook`
  }

  /**
   * Get the service role key for this project (needed to invoke Edge Functions)
   */
  async getServiceRoleKey(): Promise<string> {
    const apiKeys = await this.api.getProjectApiKeys(this.projectRef)
    const serviceRoleKey = apiKeys?.find((k) => k.name === 'service_role')
    if (!serviceRoleKey) {
      throw new Error('Could not find service_role API key')
    }
    return serviceRoleKey.api_key
  }

  /**
   * Invoke an Edge Function
   */
  async invokeFunction(
    name: string,
    serviceRoleKey: string
  ): Promise<{ success: boolean; error?: string }> {
    const url = `https://${this.projectRef}.supabase.co/functions/v1/${name}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
    })

    const data = await response.json()
    if (!response.ok) {
      return { success: false, error: data.error || `HTTP ${response.status}` }
    }
    return data
  }
}
