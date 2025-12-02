#!/bin/bash
set -euo pipefail

# Integration test for the deploy command
# Tests the full Supabase deployment flow with real services

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/common.sh"

echo "================================================"
echo "  Stripe Sync - Deploy Integration Test"
echo "================================================"
echo ""

# Load .env file if it exists
if [ -f "$CLI_DIR/.env" ]; then
    echo "📄 Loading environment from .env file..."
    set -a
    source "$CLI_DIR/.env"
    set +a
    echo ""
fi

# Check prerequisites
check_required_tools curl jq node

# Check required environment variables (no DB password needed!)
check_env_vars SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF STRIPE_API_KEY

# Track webhook ID for cleanup
WEBHOOK_ID=""

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete Stripe webhook if we created one
    if [ -n "$WEBHOOK_ID" ]; then
        echo "   Deleting Stripe webhook: $WEBHOOK_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$WEBHOOK_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete webhook"
    fi

    # Delete Edge Functions
    for func in stripe-setup stripe-webhook stripe-worker; do
        echo "   Deleting Edge Function: $func"
        curl -s -X DELETE "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions/$func" \
            -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" > /dev/null 2>&1 || true
    done

    # Drop stripe schema
    echo "   Dropping stripe schema..."
    curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"query": "DROP SCHEMA IF EXISTS stripe CASCADE"}' > /dev/null 2>&1 || true

    echo "   Done"
}

# Register cleanup on exit
trap cleanup EXIT

# Build CLI first
echo "📦 Building CLI..."
cd "$CLI_DIR"
pnpm build > /dev/null 2>&1
echo "✓ CLI built"
echo ""

# Run deploy command (no DB password needed - migrations run via Edge Function)
echo "🚀 Running deploy command..."
node dist/index.js deploy \
    --token "$SUPABASE_ACCESS_TOKEN" \
    --project "$SUPABASE_PROJECT_REF" \
    --stripe-key "$STRIPE_API_KEY"
echo ""

# Verify Edge Functions deployed
echo "🔍 Verifying Edge Functions..."
FUNCTIONS=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions")

SETUP_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-setup") | .slug')
WEBHOOK_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-webhook") | .slug')
WORKER_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-worker") | .slug')

if [ "$SETUP_FUNC" = "stripe-setup" ]; then
    echo "✓ stripe-setup function deployed"
else
    echo "❌ stripe-setup function NOT found"
    exit 1
fi

if [ "$WEBHOOK_FUNC" = "stripe-webhook" ]; then
    echo "✓ stripe-webhook function deployed"
else
    echo "❌ stripe-webhook function NOT found"
    exit 1
fi

if [ "$WORKER_FUNC" = "stripe-worker" ]; then
    echo "✓ stripe-worker function deployed"
else
    echo "❌ stripe-worker function NOT found"
    exit 1
fi
echo ""

# Verify Stripe webhook created
echo "🔍 Verifying Stripe webhook..."
WEBHOOKS=$(curl -s -u "$STRIPE_API_KEY:" "https://api.stripe.com/v1/webhook_endpoints")
WEBHOOK_URL="https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/stripe-webhook"

WEBHOOK_DATA=$(echo "$WEBHOOKS" | jq -r --arg url "$WEBHOOK_URL" '.data[] | select(.url == $url)')

if [ -n "$WEBHOOK_DATA" ]; then
    WEBHOOK_ID=$(echo "$WEBHOOK_DATA" | jq -r '.id')
    WEBHOOK_STATUS=$(echo "$WEBHOOK_DATA" | jq -r '.status')
    echo "✓ Stripe webhook created: $WEBHOOK_ID (status: $WEBHOOK_STATUS)"
else
    echo "❌ Stripe webhook NOT found for URL: $WEBHOOK_URL"
    exit 1
fi
echo ""

# Verify database schema using Supabase Management API
echo "🔍 Verifying database schema..."
TABLES_QUERY="SELECT table_name FROM information_schema.tables WHERE table_schema = 'stripe' ORDER BY table_name"
TABLES_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$TABLES_QUERY\"}")

if echo "$TABLES_RESULT" | jq -e '.[] | select(.table_name == "customers")' > /dev/null 2>&1; then
    echo "✓ stripe.customers table exists"
else
    echo "❌ stripe.customers table NOT found"
    echo "   Response: $TABLES_RESULT"
    exit 1
fi

if echo "$TABLES_RESULT" | jq -e '.[] | select(.table_name == "_managed_webhooks")' > /dev/null 2>&1; then
    echo "✓ stripe._managed_webhooks table exists"
else
    echo "❌ stripe._managed_webhooks table NOT found"
    exit 1
fi
echo ""

# Verify pg_cron job (may not exist if pg_cron extension not available)
echo "🔍 Verifying pg_cron job..."
CRON_QUERY="SELECT jobname FROM cron.job WHERE jobname = 'stripe-sync-worker'"
CRON_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CRON_QUERY\"}" 2>/dev/null || echo "[]")

if echo "$CRON_RESULT" | jq -e '.[] | select(.jobname == "stripe-sync-worker")' > /dev/null 2>&1; then
    echo "✓ pg_cron job configured"
else
    echo "⚠️  pg_cron job NOT found (pg_cron extension may not be enabled)"
fi
echo ""

echo "================================================"
echo "✅ Deploy integration test PASSED!"
echo "================================================"
echo ""
echo "Deployed resources:"
echo "  - Edge Functions: stripe-setup, stripe-webhook, stripe-worker"
echo "  - Stripe webhook: $WEBHOOK_ID"
echo "  - Database schema: stripe.*"
echo ""
echo "Note: Webhook will be deleted during cleanup"
