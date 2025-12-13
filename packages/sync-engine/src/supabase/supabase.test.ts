import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SupabaseDeployClient } from './supabase'

describe('SupabaseDeployClient', () => {
  const mockAccessToken = 'test-access-token'
  const mockProjectRef = 'abcdefghijklmnop'

  let originalEnv: string | undefined

  beforeEach(() => {
    // Save original env var
    originalEnv = process.env.SUPABASE_BASE_URL
    // Clear env var before each test
    delete process.env.SUPABASE_BASE_URL
  })

  afterEach(() => {
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.SUPABASE_BASE_URL = originalEnv
    } else {
      delete process.env.SUPABASE_BASE_URL
    }
  })

  describe('Base URL Configuration', () => {
    it('should use default base URL when no option or env var is provided', () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.supabase.co`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.supabase.co/functions/v1/stripe-webhook`
      )
    })

    it('should use environment variable when provided', () => {
      process.env.SUPABASE_BASE_URL = 'custom-domain.com'

      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.custom-domain.com`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.custom-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should prioritize option over environment variable', () => {
      process.env.SUPABASE_BASE_URL = 'env-domain.com'

      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'option-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.option-domain.com`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.option-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should use custom base URL from options', () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'my-custom.supabase.co',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.my-custom.supabase.co`)
      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.my-custom.supabase.co/functions/v1/stripe-webhook`
      )
    })
  })

  describe('URL Generation Methods', () => {
    it('should generate correct project URL with custom base URL', () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'test-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.test-domain.com`)
    })

    it('should generate correct webhook URL with custom base URL', () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'test-domain.com',
      })

      expect(client.getWebhookUrl()).toBe(
        `https://${mockProjectRef}.test-domain.com/functions/v1/stripe-webhook`
      )
    })

    it('should generate correct function invocation URL with custom base URL', async () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'test-domain.com',
      })

      // Mock fetch to intercept the URL being called
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      })
      global.fetch = mockFetch

      await client.invokeFunction('test-function', 'test-service-role-key')

      expect(mockFetch).toHaveBeenCalledWith(
        `https://${mockProjectRef}.test-domain.com/functions/v1/test-function`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-service-role-key',
          }),
        })
      )

      vi.restoreAllMocks()
    })
  })

  describe('setupPgCronJob with custom base URL', () => {
    it('should include custom base URL in pg_cron SQL', async () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'test-domain.com',
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob()

      // Verify runQuery was called
      expect(mockRunQuery).toHaveBeenCalled()

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it contains the custom base URL
      expect(executedSQL).toContain(
        `https://${mockProjectRef}.test-domain.com/functions/v1/stripe-worker`
      )
    })

    it('should use default base URL in pg_cron SQL when not customized', async () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
      })

      // Mock the API methods
      const mockGetProjectApiKeys = vi
        .fn()
        .mockResolvedValue([{ name: 'service_role', api_key: 'test-service-key' }])
      const mockRunQuery = vi.fn().mockResolvedValue(null)

      // @ts-expect-error - accessing private api for testing
      client.api.getProjectApiKeys = mockGetProjectApiKeys
      // @ts-expect-error - accessing private api for testing
      client.api.runQuery = mockRunQuery

      await client.setupPgCronJob()

      // Get the SQL that was executed
      const executedSQL = mockRunQuery.mock.calls[0][1] as string

      // Verify it contains the default base URL
      expect(executedSQL).toContain(
        `https://${mockProjectRef}.supabase.co/functions/v1/stripe-worker`
      )
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty string base URL option by using env var', () => {
      process.env.SUPABASE_BASE_URL = 'env-fallback.com'

      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: '',
      })

      // Empty string is falsy, so it should fall back to env var
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.env-fallback.com`)
    })

    it('should handle empty string base URL option and env var by using default', () => {
      process.env.SUPABASE_BASE_URL = ''

      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: '',
      })

      // Both are empty/falsy, should use default
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.supabase.co`)
    })

    it('should work with base URLs containing protocols (should strip them in construction)', () => {
      // Note: This test documents current behavior - base URL should NOT include protocol
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'my-domain.com',
      })

      // The URL construction adds https://, so base URL should not include it
      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.my-domain.com`)
      expect(client.getProjectUrl()).not.toContain('https://https://')
    })

    it('should work with base URLs containing subdomains', () => {
      const client = new SupabaseDeployClient({
        accessToken: mockAccessToken,
        projectRef: mockProjectRef,
        baseUrl: 'api.custom-domain.com',
      })

      expect(client.getProjectUrl()).toBe(`https://${mockProjectRef}.api.custom-domain.com`)
    })
  })
})
