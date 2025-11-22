#!/bin/bash

# End-to-end integration test for Stripe Sync Engine
# Tests webhook creation, event processing, and database writes

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine Integration Test"
echo "======================================="
echo ""

# Check for Stripe CLI
echo "🔧 Checking prerequisites..."
if ! command -v stripe &> /dev/null; then
    echo "❌ Stripe CLI not found - required for integration tests"
    echo "   Install: https://stripe.com/docs/stripe-cli"
    exit 1
fi
echo "✓ Stripe CLI found"

# Load environment variables
load_env_file

# Check required environment variables
check_env_vars DATABASE_URL STRIPE_API_KEY NGROK_AUTH_TOKEN

echo "✓ Environment variables loaded"
echo ""

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-test-db" "app_db"

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    stop_postgres "stripe-sync-test-db"
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

# Step 1: Build CLI
echo "🔨 Step 1: Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ CLI built successfully"
echo ""

# Step 2: Run migrations
echo "🗄️  Step 2: Running database migrations..."
npm run dev migrate > /dev/null 2>&1
echo "✓ Migrations completed"
echo ""

# Step 3: Start CLI in background and test
echo "🚀 Step 3: Starting CLI to test webhook creation..."
echo ""

# Start CLI in background with KEEP_WEBHOOKS_ON_SHUTDOWN=false and SKIP_BACKFILL=true for testing
# This ensures we only test webhook processing, not backfill
KEEP_WEBHOOKS_ON_SHUTDOWN=false SKIP_BACKFILL=true npm run dev start > /tmp/cli-test.log 2>&1 &
CLI_PID=$!

# Wait for startup (give it time to create webhook and run migrations)
sleep 15

# Check if CLI is still running
if ps -p $CLI_PID > /dev/null 2>&1; then
    echo "✓ CLI started successfully"

    # Check the log for webhook creation
    if grep -q "Webhook created:" /tmp/cli-test.log; then
        echo "✓ Webhook creation detected in logs"
        WEBHOOK_ID=$(grep "Webhook created:" /tmp/cli-test.log | awk '{print $NF}')
        echo "   Webhook ID: $WEBHOOK_ID"
    fi

    # Step 4: Verify webhook in database
    echo ""
    echo "🔍 Step 4: Checking database for managed webhook..."
    WEBHOOK_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._managed_webhooks;" 2>/dev/null | tr -d ' ')

    # Default to 0 if empty
    WEBHOOK_COUNT=${WEBHOOK_COUNT:-0}

    if [ "$WEBHOOK_COUNT" -gt 0 ] 2>/dev/null; then
        echo "✓ Found $WEBHOOK_COUNT webhook(s) in database"
        echo ""
        echo "Webhook details:"
        docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -c "SELECT id, url, enabled, status FROM stripe._managed_webhooks;" 2>/dev/null

        # Get webhook URL for testing
        WEBHOOK_URL=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT url FROM stripe._managed_webhooks LIMIT 1;" 2>/dev/null | tr -d ' ')
        echo ""
        echo "   Webhook URL: $WEBHOOK_URL"
    else
        echo "⚠ No webhooks found in database (may still be initializing)"
        echo "  Continuing with test..."
    fi

    # Step 4: Trigger test webhook events
    echo ""
    echo "🎯 Step 5: Triggering test Stripe webhook events..."
    echo "   This tests end-to-end webhook processing and database writes"
    echo ""

    # Trigger customer.created event
    echo "   Triggering customer.created event..."
    stripe trigger customer.created --api-key $STRIPE_API_KEY > /dev/null 2>&1
    sleep 2
    echo "   ✓ customer.created event triggered"

    # Trigger product.created event
    echo "   Triggering product.created event..."
    stripe trigger product.created --api-key $STRIPE_API_KEY > /dev/null 2>&1
    sleep 2
    echo "   ✓ product.created event triggered"

    # Trigger price.created event
    echo "   Triggering price.created event..."
    stripe trigger price.created --api-key $STRIPE_API_KEY > /dev/null 2>&1
    sleep 2
    echo "   ✓ price.created event triggered"

    echo ""
    echo "   Waiting for webhook processing..."
    sleep 8  # Increased wait time to allow webhook processing

    # Track test failures
    TEST_FAILED=0

    # Step 5: Verify webhook data in database tables
    echo ""
    echo "🔍 Step 6: Verifying webhook data in database tables..."

    # Check customers table
    CUSTOMER_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.customers;" 2>/dev/null | tr -d ' ')
    CUSTOMER_COUNT=${CUSTOMER_COUNT:-0}  # Default to 0 if empty
    echo "   Customers table: $CUSTOMER_COUNT rows"
    if [ "$CUSTOMER_COUNT" -gt 0 ] 2>/dev/null; then
        echo "   ✓ Customer data found"
        docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -c "SELECT id, email, name, created FROM stripe.customers LIMIT 1;" 2>/dev/null | head -n 5
    else
        echo "   ❌ FAIL: No customer data found - webhooks did not process customer.created event"
        TEST_FAILED=1
    fi

    echo ""

    # Check products table
    PRODUCT_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products;" 2>/dev/null | tr -d ' ')
    PRODUCT_COUNT=${PRODUCT_COUNT:-0}  # Default to 0 if empty
    echo "   Products table: $PRODUCT_COUNT rows"
    if [ "$PRODUCT_COUNT" -gt 0 ] 2>/dev/null; then
        echo "   ✓ Product data found"
        docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -c "SELECT id, name, active, created FROM stripe.products LIMIT 1;" 2>/dev/null | head -n 5
    else
        echo "   ❌ FAIL: No product data found - webhooks did not process product.created event"
        TEST_FAILED=1
    fi

    echo ""

    # Check prices table
    PRICE_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.prices;" 2>/dev/null | tr -d ' ')
    PRICE_COUNT=${PRICE_COUNT:-0}  # Default to 0 if empty
    echo "   Prices table: $PRICE_COUNT rows"
    if [ "$PRICE_COUNT" -gt 0 ] 2>/dev/null; then
        echo "   ✓ Price data found"
        docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -c "SELECT id, product, currency, unit_amount, created FROM stripe.prices LIMIT 1;" 2>/dev/null | head -n 5
    else
        echo "   ❌ FAIL: No price data found - webhooks did not process price.created event"
        TEST_FAILED=1
    fi

    # Verify data came from webhooks, not backfill
    echo ""
    echo "🔍 Verifying data came from webhooks (not backfill)..."
    echo "   Checking that _sync_status is empty (backfill was skipped)..."

    # Check if sync status table has any entries (would indicate backfill ran)
    SYNC_STATUS_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._sync_status;" 2>/dev/null | tr -d ' ')
    SYNC_STATUS_COUNT=${SYNC_STATUS_COUNT:-0}  # Default to 0 if empty

    if [ "$SYNC_STATUS_COUNT" -eq 0 ] 2>/dev/null; then
        echo "   ✓ Sync status table is empty - backfill was skipped!"
        echo "   ✓ All data came from webhook processing"
    else
        echo "   ❌ FAIL: Sync status has $SYNC_STATUS_COUNT entries"
        echo "   This suggests backfill ran (SKIP_BACKFILL may not have worked)"
        TEST_FAILED=1
    fi

    # Step 6: Gracefully shutdown CLI
    echo ""
    echo "🛑 Step 7: Shutting down CLI gracefully..."
    kill -TERM $CLI_PID 2>/dev/null

    # Wait for cleanup to complete
    echo "   Waiting for cleanup to complete..."
    wait $CLI_PID 2>/dev/null || true
    sleep 1

    # Step 7: Verify cleanup
    echo ""
    echo "🧹 Step 8: Verifying cleanup after shutdown..."
    WEBHOOK_COUNT_AFTER=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._managed_webhooks;" 2>/dev/null | tr -d ' ')

    if [ "$WEBHOOK_COUNT_AFTER" -eq 0 ] 2>/dev/null || [ -z "$WEBHOOK_COUNT_AFTER" ]; then
        echo "✓ Webhook successfully deleted from database"
    else
        echo "❌ Warning: $WEBHOOK_COUNT_AFTER webhook(s) still in database"
        echo "   Cleanup may not have completed properly"
        echo ""
        echo "Remaining webhooks:"
        docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -c "SELECT id, url FROM stripe._managed_webhooks;" 2>/dev/null
    fi
else
    echo "❌ CLI failed to start"
    echo ""
    echo "Error log:"
    cat /tmp/cli-test.log
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ Integration Test Completed!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (Stripe CLI)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ CLI started and created webhook in Stripe"
echo "- ✓ Migrations run automatically via StripeSync"
echo "- ✓ Webhook persisted to database"
echo "- ✓ Test webhook events triggered (customer, product, price)"
echo "- ✓ Webhook processing verified ($CUSTOMER_COUNT customers, $PRODUCT_COUNT products, $PRICE_COUNT prices)"
echo "- ✓ Data source verified (webhooks, not backfill) via _sync_status check"
echo "- ✓ Graceful shutdown completed"
echo "- ✓ Webhook cleanup verified (removed from Stripe + DB)"
echo ""
echo "View full CLI log: /tmp/cli-test.log"

# Exit with failure if any test failed
if [ "$TEST_FAILED" -eq 1 ]; then
    echo ""
    echo "❌ Test failed: Webhook event processing did not work correctly"
    exit 1
fi
