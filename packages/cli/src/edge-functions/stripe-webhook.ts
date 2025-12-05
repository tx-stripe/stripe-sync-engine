import { StripeSync } from 'npm:stripe-experiment-sync'

// Get and validate database URL at startup
const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
if (!rawDbUrl) {
  throw new Error('SUPABASE_DB_URL environment variable is not set')
}
// Remove sslmode from connection string (not supported by pg in Deno)
const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')

const stripeSync = new StripeSync({
  poolConfig: { connectionString: dbUrl, max: 1 },
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
    // Use 400 for signature verification failures (client error),
    // 500 for internal processing errors
    const isSignatureError =
      error.message?.includes('signature') || error.type === 'StripeSignatureVerificationError'
    const status = isSignatureError ? 400 : 500
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
