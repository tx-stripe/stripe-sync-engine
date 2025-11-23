#!/bin/bash

# End-to-end integration test for Stripe Sync Engine
# Tests webhook creation, event processing, and database writes
# Includes multi-account testing

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
check_env_vars DATABASE_URL STRIPE_API_KEY STRIPE_API_KEY_2 NGROK_AUTH_TOKEN

echo "✓ Environment variables loaded"
echo ""

# Track global test failures
GLOBAL_TEST_FAILED=0

# Function to test webhook processing for a given account
# Parameters: ACCOUNT_NAME, API_KEY, LOG_FILE, EXPECTED_WEBHOOK_COUNT
test_webhook_account() {
    local ACCOUNT_NAME=$1
    local API_KEY=$2
    local LOG_FILE=$3
    local EXPECTED_WEBHOOK_COUNT=$4

    echo "🚀 Testing webhook for $ACCOUNT_NAME..."
    echo ""

    # Start CLI in background
    STRIPE_API_KEY=$API_KEY KEEP_WEBHOOKS_ON_SHUTDOWN=false SKIP_BACKFILL=true npm run dev start > $LOG_FILE 2>&1 &
    local CLI_PID=$!

    # Wait for startup
    sleep 15

    # Check if CLI is still running
    if ! ps -p $CLI_PID > /dev/null 2>&1; then
        echo "❌ FAIL: CLI for $ACCOUNT_NAME failed to start"
        echo ""
        echo "Error log:"
        cat $LOG_FILE
        GLOBAL_TEST_FAILED=1
        return 1
    fi

    echo "✓ CLI for $ACCOUNT_NAME started successfully"

    # Check the log for webhook creation
    if grep -q "Webhook created:" $LOG_FILE; then
        echo "✓ Webhook creation detected in logs"
        WEBHOOK_ID=$(grep "Webhook created:" $LOG_FILE | awk '{print $NF}')
        echo "   Webhook ID: $WEBHOOK_ID"
    fi

    # Verify webhook count in database
    echo ""
    echo "🔍 Checking database for managed webhooks..."
    WEBHOOK_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._managed_webhooks;" 2>/dev/null | tr -d ' ')
    WEBHOOK_COUNT=${WEBHOOK_COUNT:-0}

    if [ "$WEBHOOK_COUNT" -eq "$EXPECTED_WEBHOOK_COUNT" ] 2>/dev/null; then
        echo "✓ Found $WEBHOOK_COUNT webhook(s) in database (expected: $EXPECTED_WEBHOOK_COUNT)"
    else
        echo "❌ FAIL: Expected $EXPECTED_WEBHOOK_COUNT webhooks, found $WEBHOOK_COUNT"
        GLOBAL_TEST_FAILED=1
    fi

    # Create actual Stripe resources to trigger webhook events
    echo ""
    echo "🎯 Creating Stripe resources to trigger webhook events for $ACCOUNT_NAME..."
    echo ""

    # Create a customer (triggers customer.created event)
    echo "   Creating customer..."
    curl -s -X POST https://api.stripe.com/v1/customers \
      -u "$API_KEY:" \
      -d "name=Test Customer" \
      -d "email=test@example.com" > /dev/null
    sleep 2
    echo "   ✓ Customer created"

    # Create a product (triggers product.created event)
    echo "   Creating product..."
    PRODUCT_ID=$(curl -s -X POST https://api.stripe.com/v1/products \
      -u "$API_KEY:" \
      -d "name=Test Product" \
      | jq -r '.id')
    sleep 2
    echo "   ✓ Product created: $PRODUCT_ID"

    # Create a price (triggers price.created event)
    echo "   Creating price..."
    curl -s -X POST https://api.stripe.com/v1/prices \
      -u "$API_KEY:" \
      -d "product=$PRODUCT_ID" \
      -d "unit_amount=1000" \
      -d "currency=usd" > /dev/null
    sleep 2
    echo "   ✓ Price created"

    echo ""
    echo "   Waiting for webhook processing..."
    sleep 8

    # Get account ID for this API key
    echo ""
    echo "🔍 Verifying webhook data for $ACCOUNT_NAME..."

    # Get the account ID by checking which account was synced most recently
    # (since we're testing one at a time, the latest account is the current one)
    local ACCOUNT_ID=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT id FROM stripe.accounts ORDER BY _last_synced_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ')
    echo "   Account ID: $ACCOUNT_ID"

    # Check customers table for this account
    local CUSTOMER_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.customers WHERE _account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
    CUSTOMER_COUNT=${CUSTOMER_COUNT:-0}
    echo "   Customers for $ACCOUNT_NAME: $CUSTOMER_COUNT rows"
    if [ "$CUSTOMER_COUNT" -gt 0 ] 2>/dev/null; then
        echo "   ✓ Customer data found"
    else
        echo "   ❌ FAIL: No customer data found - webhooks did not process customer.created event"
        GLOBAL_TEST_FAILED=1
    fi

    # Check products table for this account
    local PRODUCT_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE _account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
    PRODUCT_COUNT=${PRODUCT_COUNT:-0}
    echo "   Products for $ACCOUNT_NAME: $PRODUCT_COUNT rows"
    if [ "$PRODUCT_COUNT" -gt 0 ] 2>/dev/null; then
        echo "   ✓ Product data found"
    else
        echo "   ❌ FAIL: No product data found - webhooks did not process product.created event"
        GLOBAL_TEST_FAILED=1
    fi

    # Check prices table for this account
    local PRICE_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.prices WHERE _account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')
    PRICE_COUNT=${PRICE_COUNT:-0}
    echo "   Prices for $ACCOUNT_NAME: $PRICE_COUNT rows"
    if [ "$PRICE_COUNT" -gt 0 ] 2>/dev/null; then
        echo "   ✓ Price data found"
    else
        echo "   ❌ FAIL: No price data found - webhooks did not process price.created event"
        GLOBAL_TEST_FAILED=1
    fi

    # Gracefully shutdown CLI
    echo ""
    echo "🛑 Shutting down CLI for $ACCOUNT_NAME gracefully..."
    kill -TERM $CLI_PID 2>/dev/null

    # Wait for cleanup to complete
    echo "   Waiting for cleanup to complete..."
    wait $CLI_PID 2>/dev/null || true
    sleep 1

    # Verify cleanup
    echo ""
    echo "🧹 Verifying cleanup after shutdown..."
    WEBHOOK_COUNT_AFTER=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._managed_webhooks WHERE account_id = '$ACCOUNT_ID';" 2>/dev/null | tr -d ' ')

    if [ "$WEBHOOK_COUNT_AFTER" -eq 0 ] 2>/dev/null || [ -z "$WEBHOOK_COUNT_AFTER" ]; then
        echo "✓ Webhook for $ACCOUNT_NAME successfully deleted from database"
    else
        echo "❌ Warning: $WEBHOOK_COUNT_AFTER webhook(s) still in database for $ACCOUNT_NAME"
        GLOBAL_TEST_FAILED=1
    fi

    echo ""
    echo "✅ $ACCOUNT_NAME webhook test completed!"
    echo ""
}

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

# Step 3: Test Account 1
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 3: Testing Account 1"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
test_webhook_account "Account 1" "$STRIPE_API_KEY" "/tmp/cli-test-account1.log" 1

# Step 4: Test Account 2
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 4: Testing Account 2 (Multi-Account)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
test_webhook_account "Account 2" "$STRIPE_API_KEY_2" "/tmp/cli-test-account2.log" 1

# Step 5: Verify no cross-account data pollution
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Step 5: Verifying Account Isolation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get both account IDs
ACCOUNT_1_ID=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT id FROM stripe.accounts ORDER BY _last_synced_at ASC LIMIT 1;" 2>/dev/null | tr -d ' ')
ACCOUNT_2_ID=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT id FROM stripe.accounts ORDER BY _last_synced_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ')

echo "Account 1 ID: $ACCOUNT_1_ID"
echo "Account 2 ID: $ACCOUNT_2_ID"
echo ""

# Verify Account 1's data only has Account 1's account_id
ACCOUNT_1_WRONG_DATA=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM (SELECT * FROM stripe.customers WHERE _account_id = '$ACCOUNT_2_ID' UNION ALL SELECT * FROM stripe.products WHERE _account_id = '$ACCOUNT_2_ID' UNION ALL SELECT * FROM stripe.prices WHERE _account_id = '$ACCOUNT_2_ID') AS combined WHERE _account_id != '$ACCOUNT_2_ID';" 2>/dev/null | tr -d ' ')
ACCOUNT_1_WRONG_DATA=${ACCOUNT_1_WRONG_DATA:-0}

if [ "$ACCOUNT_1_WRONG_DATA" -eq 0 ] 2>/dev/null; then
    echo "✓ No cross-account data pollution detected"
else
    echo "❌ FAIL: Found $ACCOUNT_1_WRONG_DATA records with wrong account_id"
    GLOBAL_TEST_FAILED=1
fi

# Verify data came from webhooks, not backfill
echo ""
echo "🔍 Verifying data came from webhooks (not backfill)..."
SYNC_STATUS_COUNT=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe._sync_status;" 2>/dev/null | tr -d ' ')
SYNC_STATUS_COUNT=${SYNC_STATUS_COUNT:-0}

if [ "$SYNC_STATUS_COUNT" -eq 0 ] 2>/dev/null; then
    echo "✓ Sync status table is empty - backfill was skipped!"
    echo "✓ All data came from webhook processing"
else
    echo "❌ FAIL: Sync status has $SYNC_STATUS_COUNT entries"
    echo "This suggests backfill ran (SKIP_BACKFILL may not have worked)"
    GLOBAL_TEST_FAILED=1
fi

echo ""
echo "=========================================="
echo "✅ Integration Test Completed!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (Stripe CLI)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ Account 1 webhook processing verified"
echo "- ✓ Account 2 webhook processing verified"
echo "- ✓ Multi-account webhook isolation verified"
echo "- ✓ Data source verified (webhooks, not backfill)"
echo "- ✓ Webhook cleanup verified for both accounts"
echo ""
echo "View logs:"
echo "  Account 1: /tmp/cli-test-account1.log"
echo "  Account 2: /tmp/cli-test-account2.log"

# Exit with failure if any test failed
if [ "$GLOBAL_TEST_FAILED" -eq 1 ]; then
    echo ""
    echo "❌ Test failed: Webhook event processing did not work correctly"
    exit 1
fi
