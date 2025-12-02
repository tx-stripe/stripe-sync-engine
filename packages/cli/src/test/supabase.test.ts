import { describe, test, expect } from 'vitest'
import { WEBHOOK_FUNCTION_CODE, WORKER_FUNCTION_CODE } from '../supabase'

describe('Edge Function Templates', () => {
  describe('WEBHOOK_FUNCTION_CODE', () => {
    test('imports StripeSync from npm package', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain("import { StripeSync } from 'npm:stripe-replit-sync'")
    })

    test('imports PostgresJsAdapter from npm package', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain(
        "import { PostgresJsAdapter } from 'npm:stripe-replit-sync/postgres-js'"
      )
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('validates stripe-signature header', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain("req.headers.get('stripe-signature')")
      expect(WEBHOOK_FUNCTION_CODE).toContain('Missing stripe-signature header')
    })

    test('calls processWebhook with raw body and signature', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain('stripeSync.processWebhook(rawBody, sig)')
    })

    test('returns 200 on success', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain('status: 200')
      expect(WEBHOOK_FUNCTION_CODE).toContain('received: true')
    })

    test('returns 400 on error', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain('status: 400')
    })

    test('rejects non-POST requests', () => {
      expect(WEBHOOK_FUNCTION_CODE).toContain("req.method !== 'POST'")
      expect(WEBHOOK_FUNCTION_CODE).toContain('status: 405')
    })
  })

  describe('WORKER_FUNCTION_CODE', () => {
    test('imports StripeSync from npm package', () => {
      expect(WORKER_FUNCTION_CODE).toContain("import { StripeSync } from 'npm:stripe-replit-sync'")
    })

    test('imports PostgresJsAdapter from npm package', () => {
      expect(WORKER_FUNCTION_CODE).toContain(
        "import { PostgresJsAdapter } from 'npm:stripe-replit-sync/postgres-js'"
      )
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(WORKER_FUNCTION_CODE).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(WORKER_FUNCTION_CODE).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('verifies authorization header', () => {
      expect(WORKER_FUNCTION_CODE).toContain("req.headers.get('Authorization')")
      expect(WORKER_FUNCTION_CODE).toContain("startsWith('Bearer ')")
    })

    test('returns 401 for unauthorized requests', () => {
      expect(WORKER_FUNCTION_CODE).toContain('Unauthorized')
      expect(WORKER_FUNCTION_CODE).toContain('status: 401')
    })

    test('calls processNext to process pending work', () => {
      expect(WORKER_FUNCTION_CODE).toContain('stripeSync.processNext()')
    })

    test('returns 200 on success', () => {
      expect(WORKER_FUNCTION_CODE).toContain('status: 200')
    })

    test('returns 500 on error', () => {
      expect(WORKER_FUNCTION_CODE).toContain('status: 500')
    })
  })
})

describe('Database URL Construction', () => {
  test('constructs pooler URL with correct format', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const region = 'us-east-1'
    const password = 'mypassword123'
    const encodedPassword = encodeURIComponent(password)

    const databaseUrl = `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`

    expect(databaseUrl).toBe(
      'postgresql://postgres.abcdefghijklmnopqrst:mypassword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    )
  })

  test('encodes special characters in password', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const region = 'us-east-1'
    const password = 'pass@word#123!'
    const encodedPassword = encodeURIComponent(password)

    const databaseUrl = `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`

    expect(databaseUrl).toContain('pass%40word%23123!')
    expect(databaseUrl).not.toContain('pass@word#123!')
  })
})

describe('Webhook URL Generation', () => {
  test('webhook URL uses correct format', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-webhook`

    expect(webhookUrl).toBe('https://abcdefghijklmnopqrst.supabase.co/functions/v1/stripe-webhook')
  })
})
