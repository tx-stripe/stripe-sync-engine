import chalk from 'chalk'
import express from 'express'
import http from 'node:http'
import dotenv from 'dotenv'
import { loadConfig, CliOptions } from './config'
import { StripeSync, type SyncObject, runMigrations } from 'stripe-replit-sync'
import { PgAdapter } from 'stripe-replit-sync/pg'
import { createTunnel, NgrokTunnel } from './ngrok'
import {
  SupabaseDeployClient,
  getSetupFunctionCode,
  getWebhookFunctionCode,
  getWorkerFunctionCode,
} from './supabase'

export interface DeployOptions {
  token?: string
  project?: string
  stripeKey?: string
}

const VALID_SYNC_OBJECTS: SyncObject[] = [
  'all',
  'customer',
  'customer_with_entitlements',
  'invoice',
  'price',
  'product',
  'subscription',
  'subscription_schedules',
  'setup_intent',
  'payment_method',
  'dispute',
  'charge',
  'payment_intent',
  'plan',
  'tax_id',
  'credit_note',
  'early_fraud_warning',
  'refund',
  'checkout_sessions',
]

/**
 * Backfill command - backfills a specific entity type from Stripe.
 */
export async function backfillCommand(options: CliOptions, entityName: string): Promise<void> {
  try {
    // Validate entity name
    if (!VALID_SYNC_OBJECTS.includes(entityName as SyncObject)) {
      console.error(
        chalk.red(
          `Error: Invalid entity name "${entityName}". Valid entities are: ${VALID_SYNC_OBJECTS.join(', ')}`
        )
      )
      process.exit(1)
    }

    // For backfill, we only need stripe key and database URL (not ngrok token)
    dotenv.config()

    let stripeApiKey =
      options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''
    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

    if (!stripeApiKey || !databaseUrl) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!stripeApiKey) {
        questions.push({
          type: 'password',
          name: 'stripeApiKey',
          message: 'Enter your Stripe API key:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'Stripe API key is required'
            }
            if (!input.startsWith('sk_')) {
              return 'Stripe API key should start with "sk_"'
            }
            return true
          },
        })
      }

      if (!databaseUrl) {
        questions.push({
          type: 'password',
          name: 'databaseUrl',
          message: 'Enter your Postgres DATABASE_URL:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'DATABASE_URL is required'
            }
            if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
              return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
            }
            return true
          },
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.stripeApiKey) stripeApiKey = answers.stripeApiKey
        if (answers.databaseUrl) databaseUrl = answers.databaseUrl
      }
    }

    const config = {
      stripeApiKey,
      databaseUrl,
      ngrokAuthToken: '', // Not needed for backfill
    }
    console.log(chalk.blue(`Backfilling ${entityName} from Stripe in 'stripe' schema...`))
    console.log(chalk.gray(`Database: ${config.databaseUrl.replace(/:[^:@]+@/, ':****@')}`))

    // Create adapter
    const adapter = new PgAdapter({
      connectionString: config.databaseUrl,
      max: 10,
    })

    // Run migrations first
    try {
      await runMigrations(adapter)
    } catch (migrationError) {
      console.error(chalk.red('Failed to run migrations:'))
      console.error(
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )
      throw migrationError
    }

    const stripeSync = new StripeSync({
      stripeSecretKey: config.stripeApiKey,
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      adapter,
    })

    // Run sync for the specified entity
    const result = await stripeSync.processUntilDone({ object: entityName as SyncObject })
    const totalSynced = Object.values(result).reduce(
      (sum, syncResult) => sum + (syncResult?.synced || 0),
      0
    )

    console.log(chalk.green(`✓ Backfill complete: ${totalSynced} ${entityName} objects synced`))
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    process.exit(1)
  }
}

/**
 * Migration command - runs database migrations only.
 */
export async function migrateCommand(options: CliOptions): Promise<void> {
  try {
    // For migrations, we only need the database URL
    dotenv.config()

    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

    if (!databaseUrl) {
      const inquirer = (await import('inquirer')).default
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'databaseUrl',
          message: 'Enter your Postgres DATABASE_URL:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'DATABASE_URL is required'
            }
            if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
              return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
            }
            return true
          },
        },
      ])
      databaseUrl = answers.databaseUrl
    }

    console.log(chalk.blue("Running database migrations in 'stripe' schema..."))
    console.log(chalk.gray(`Database: ${databaseUrl.replace(/:[^:@]+@/, ':****@')}`))

    const adapter = new PgAdapter({
      connectionString: databaseUrl,
      max: 5,
    })

    try {
      await runMigrations(adapter)
      console.log(chalk.green('✓ Migrations completed successfully'))
    } catch (migrationError) {
      // Migration failed - drop schema and retry
      console.warn(chalk.yellow('Migrations failed.'))
      console.warn(
        'Migration error:',
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )
      throw migrationError
    } finally {
      await adapter.end()
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    process.exit(1)
  }
}

/**
 * Main sync command - syncs Stripe data to PostgreSQL using webhooks for real-time updates.
 * 1. Runs database migrations
 * 2. Creates StripeSync instance
 * 3. Creates ngrok tunnel and Stripe webhook endpoint
 * 4. Runs initial backfill of all Stripe data
 * 5. Keeps running to process live webhook events (Ctrl+C to stop)
 */
export async function syncCommand(options: CliOptions): Promise<void> {
  let stripeSync: StripeSync | null = null
  let tunnel: NgrokTunnel | null = null
  let server: http.Server | null = null
  let webhookId: string | null = null

  // Setup cleanup handler
  const cleanup = async (signal?: string) => {
    console.log(chalk.blue(`\n\nCleaning up... (signal: ${signal || 'manual'})`))

    // Delete webhook endpoint if created (unless keepWebhooksOnShutdown is true)
    const keepWebhooksOnShutdown = process.env.KEEP_WEBHOOKS_ON_SHUTDOWN === 'true'
    if (webhookId && stripeSync && !keepWebhooksOnShutdown) {
      try {
        await stripeSync.deleteManagedWebhook(webhookId)
        console.log(chalk.green('✓ Webhook cleanup complete'))
      } catch {
        console.log(chalk.yellow('⚠ Could not delete webhook'))
      }
    }

    // Close server
    if (server) {
      try {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        console.log(chalk.green('✓ Server stopped'))
      } catch {
        console.log(chalk.yellow('⚠ Server already stopped'))
      }
    }

    // Close tunnel
    if (tunnel) {
      try {
        await tunnel.close()
      } catch {
        console.log(chalk.yellow('⚠ Could not close tunnel'))
      }
    }

    process.exit(0)
  }

  // Register cleanup handlers
  process.on('SIGINT', () => cleanup('SIGINT'))
  process.on('SIGTERM', () => cleanup('SIGTERM'))

  try {
    // Load configuration
    const config = await loadConfig(options)

    // Show command with database URL
    console.log(chalk.gray(`$ stripe-sync start ${config.databaseUrl}`))

    // 1. Create adapter
    const adapter = new PgAdapter({
      connectionString: config.databaseUrl,
      max: 10,
    })

    // 2. Run migrations
    try {
      await runMigrations(adapter)
    } catch (migrationError) {
      // Migration failed - drop schema and retry
      console.warn(chalk.yellow('Migrations failed.'))
      console.warn(
        'Migration error:',
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )
      throw migrationError
    }

    stripeSync = new StripeSync({
      stripeSecretKey: config.stripeApiKey,
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      adapter,
    })

    // Create ngrok tunnel and webhook endpoint
    const port = 3000
    tunnel = await createTunnel(port, config.ngrokAuthToken)

    // Create managed webhook endpoint
    const webhookPath = process.env.WEBHOOK_PATH || '/stripe-webhooks'
    console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
    const webhook = await stripeSync.findOrCreateManagedWebhook(`${tunnel.url}${webhookPath}`)
    webhookId = webhook.id
    const eventCount = webhook.enabled_events?.length || 0
    console.log(chalk.green(`✓ Webhook created: ${webhook.id}`))
    console.log(chalk.cyan(`  URL: ${webhook.url}`))
    console.log(chalk.cyan(`  Events: ${eventCount} supported events`))

    // Create Express app and mount webhook handler
    const app = express()

    // Mount webhook handler with raw body parser (BEFORE any other body parsing)
    const webhookRoute = webhookPath
    app.use(webhookRoute, express.raw({ type: 'application/json' }))

    app.post(webhookRoute, async (req, res) => {
      const sig = req.headers['stripe-signature']
      if (!sig || typeof sig !== 'string') {
        console.error('[Webhook] Missing stripe-signature header')
        return res.status(400).send({ error: 'Missing stripe-signature header' })
      }

      const rawBody = req.body

      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        console.error('[Webhook] Body is not a Buffer!')
        return res.status(400).send({ error: 'Missing raw body for signature verification' })
      }

      try {
        await stripeSync!.processWebhook(rawBody, sig)
        return res.status(200).send({ received: true })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('[Webhook] Processing error:', errorMessage)
        return res.status(400).send({ error: errorMessage })
      }
    })

    // Apply body parsing middleware for other routes (after webhook handler)
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))

    // Health check endpoint
    app.get('/health', async (req, res) => {
      return res.status(200).json({ status: 'ok' })
    })

    // Start Express server
    console.log(chalk.blue(`\nStarting server on port ${port}...`))
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '0.0.0.0', () => {
        resolve()
      })
      server.on('error', reject)
    })
    console.log(chalk.green(`✓ Server started on port ${port}`))

    // Run initial sync of all Stripe data (unless disabled)
    if (process.env.SKIP_BACKFILL !== 'true') {
      console.log(chalk.blue('\nStarting initial sync of all Stripe data...'))
      const syncResult = await stripeSync.processUntilDone()
      const totalSynced = Object.values(syncResult).reduce(
        (sum, result) => sum + (result?.synced || 0),
        0
      )
      console.log(chalk.green(`✓ Sync complete: ${totalSynced} objects synced`))
    } else {
      console.log(chalk.yellow('\n⏭️  Skipping initial sync (SKIP_BACKFILL=true)'))
    }

    console.log(
      chalk.cyan('\n● Streaming live changes...') + chalk.gray(' [press Ctrl-C to abort]')
    )

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    await cleanup()
    process.exit(1)
  }
}

/**
 * Deploy command - deploys Stripe Sync to Supabase.
 * 1. Validates project access and gets region
 * 2. Deploys migrate Edge Function and runs migrations remotely
 * 3. Creates Stripe webhook via Stripe API
 * 4. Deploys webhook Edge Function
 * 5. Deploys worker Edge Function
 * 6. Configures secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
 * 7. Sets up pg_cron job for worker
 * 8. Outputs success
 */
export async function deployCommand(options: DeployOptions): Promise<void> {
  try {
    dotenv.config()

    // Gather configuration
    let token = options.token || process.env.SUPABASE_ACCESS_TOKEN || ''
    let project = options.project || process.env.SUPABASE_PROJECT_REF || ''
    let stripeKey =
      options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''

    // Prompt for missing values
    if (!token || !project || !stripeKey) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!token) {
        questions.push({
          type: 'password',
          name: 'token',
          message: 'Enter your Supabase access token:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'Supabase access token is required'
            }
            return true
          },
        })
      }

      if (!project) {
        questions.push({
          type: 'input',
          name: 'project',
          message: 'Enter your Supabase project reference:',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'Project reference is required'
            }
            if (!/^[a-z]{20}$/.test(input)) {
              return 'Project reference should be a 20-character lowercase string (e.g., abcdefghijklmnopqrst)'
            }
            return true
          },
        })
      }

      if (!stripeKey) {
        questions.push({
          type: 'password',
          name: 'stripeKey',
          message: 'Enter your Stripe secret key:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'Stripe secret key is required'
            }
            if (!input.startsWith('sk_')) {
              return 'Stripe API key should start with "sk_"'
            }
            return true
          },
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.token) token = answers.token
        if (answers.project) project = answers.project
        if (answers.stripeKey) stripeKey = answers.stripeKey
      }
    }

    console.log(chalk.blue('\nDeploying Stripe Sync to Supabase...'))

    // Initialize Supabase deploy client
    const supabaseClient = new SupabaseDeployClient({
      accessToken: token,
      projectRef: project,
    })

    // 1. Validate project access and get region
    console.log(chalk.gray('Validating project access...'))
    const projectInfo = await supabaseClient.validateProject()
    console.log(chalk.green(`✓ Connected to project: ${projectInfo.name} (${projectInfo.region})`))

    // 2. Configure secrets first (needed for setup function)
    console.log(chalk.gray('Configuring secrets...'))
    await supabaseClient.setSecrets({
      STRIPE_SECRET_KEY: stripeKey,
    })
    console.log(chalk.green('✓ Secrets configured'))

    // 3. Deploy and run setup function (migrations + managed webhook)
    console.log(chalk.gray('Deploying stripe-setup function...'))
    const setupCode = getSetupFunctionCode(project)
    await supabaseClient.deployFunction('stripe-setup', setupCode)
    console.log(chalk.green('✓ Deployed stripe-setup function'))

    console.log(chalk.gray('Running setup (migrations + webhook)...'))
    const serviceRoleKey = await supabaseClient.getServiceRoleKey()
    const setupResult = await supabaseClient.invokeFunction('stripe-setup', serviceRoleKey)
    if (!setupResult.success) {
      throw new Error(`Setup failed: ${setupResult.error}`)
    }
    console.log(chalk.green('✓ Migrations applied'))
    console.log(chalk.green(`✓ Stripe webhook configured (${setupResult.webhookId})`))

    const webhookUrl = supabaseClient.getWebhookUrl()

    // 4. Deploy webhook Edge Function
    console.log(chalk.gray('Deploying stripe-webhook function...'))
    await supabaseClient.deployFunction('stripe-webhook', getWebhookFunctionCode())
    console.log(chalk.green('✓ Deployed stripe-webhook function'))

    // 5. Deploy worker Edge Function
    console.log(chalk.gray('Deploying stripe-worker function...'))
    await supabaseClient.deployFunction('stripe-worker', getWorkerFunctionCode())
    console.log(chalk.green('✓ Deployed stripe-worker function'))

    // 6. Setup pg_cron job
    console.log(chalk.gray('Setting up pg_cron job...'))
    try {
      await supabaseClient.setupPgCronJob()
      console.log(chalk.green('✓ pg_cron job configured (runs every 10 seconds)'))
    } catch {
      console.log(
        chalk.yellow(
          '⚠ Could not setup pg_cron job automatically. You may need to enable pg_cron extension manually.'
        )
      )
    }

    // 7. Output success
    console.log(chalk.green('\n✅ Stripe Sync Engine deployed to Supabase!'))
    console.log('')
    console.log(chalk.cyan('✓ Migrations applied (via Edge Function)'))
    console.log(chalk.cyan(`🪝 Stripe webhook configured (${setupResult.webhookId})`))
    console.log(chalk.cyan('⚡ Edge Functions deployed'))
    console.log(chalk.cyan('🔐 Secrets configured'))
    console.log(chalk.cyan('⏰ pg_cron job configured'))
    console.log('')
    console.log(chalk.white(`Webhook URL: ${webhookUrl}`))
    console.log('')
    console.log(chalk.green("That's it! Webhook is already configured in Stripe."))
    console.log('')
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`Error: ${error.message}`))
    }
    process.exit(1)
  }
}
