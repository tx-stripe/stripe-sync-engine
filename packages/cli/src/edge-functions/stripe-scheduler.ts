import { StripeSync } from 'npm:stripe-experiment-sync'

// Get and validate environment variables at startup
const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!rawDbUrl) {
  throw new Error('SUPABASE_DB_URL environment variable is not set')
}
const supabaseUrl = Deno.env.get('SUPABASE_URL')
if (!supabaseUrl) {
  throw new Error('SUPABASE_URL environment variable is not set')
}

// Remove sslmode from connection string (not supported by pg in Deno)
const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')
const workerUrl = supabaseUrl + '/functions/v1/stripe-worker'

const stripeSync = new StripeSync({
  poolConfig: { connectionString: dbUrl, max: 2 },
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
})

Deno.serve(async (req) => {
  // Verify authorization (service role key from pg_cron)
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const objects = stripeSync.getSupportedSyncObjects()

    // Invoke worker for each object type (fire-and-forget)
    for (const object of objects) {
      fetch(workerUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ object }),
      }).catch((err) => console.error('Failed to invoke worker for', object, err))
    }

    return new Response(JSON.stringify({ scheduled: objects }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Scheduler error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
