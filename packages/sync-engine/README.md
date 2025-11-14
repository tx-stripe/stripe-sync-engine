# Stripe Sync Engine

![GitHub License](https://img.shields.io/github/license/tx-stripe/stripe-sync-engine)
![NPM Version](https://img.shields.io/npm/v/stripe-replit-sync)

A TypeScript library to synchronize Stripe data into a PostgreSQL database, designed for use in Node.js backends and serverless environments.

## Features

- Automatically manages Stripe webhooks for real-time updates
- Sync Stripe objects (customers, invoices, products, etc.) to your PostgreSQL database
- Automatic database migrations
- Express middleware integration with automatic body parsing
- UUID-based webhook routing for security

## Installation

```sh
npm install stripe-replit-sync stripe
# or
pnpm add stripe-replit-sync stripe
# or
yarn add stripe-replit-sync stripe
```

## Usage

Initialize the `StripeSync` class with your configuration:

```typescript
import { StripeSync } from 'stripe-replit-sync'

const sync = new StripeSync({
  poolConfig: {
    connectionString: 'postgres://user:pass@host:port/db',
    max: 10, // Maximum number of connections
  },
  stripeSecretKey: 'sk_test_...',
  // Optional: webhook secret for signature validation
  stripeWebhookSecret: 'whsec_...',
  // Optional: pino logger instance
  logger: myLogger,
})
```

### Processing Webhooks

```typescript
// Process a webhook with signature validation
await sync.processWebhook(payload, signature, uuid)

// Or process an event directly
await sync.processEvent(event)
```

### Managed Webhook Endpoints

The library provides methods to create and manage webhook endpoints with UUID-based routing for security:

```typescript
// Create or reuse an existing webhook endpoint for a base URL
const { webhook, uuid } = await sync.findOrCreateManagedWebhook(
  'https://example.com/stripe-webhooks',
  {
    enabled_events: ['*'], // or specific events like ['customer.created', 'invoice.paid']
    description: 'My app webhook',
  }
)
// webhook.url will be: https://example.com/stripe-webhooks/{uuid}

// Create a new webhook endpoint (always creates new)
const { webhook, uuid } = await sync.createManagedWebhook(
  'https://example.com/stripe-webhooks',
  {
    enabled_events: ['customer.created', 'customer.updated'],
  }
)

// Get a managed webhook by ID
const webhook = await sync.getManagedWebhook('we_xxx')

// Delete a managed webhook
await sync.deleteManagedWebhook('we_xxx')
```

The UUID-based routing allows multiple webhook endpoints for the same base URL, making it ideal for:
- Development environments with ngrok/tunnels that change URLs
- Multi-tenant applications
- Testing and staging environments

## Configuration

| Option                          | Type    | Description                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poolConfig` | object | **Required.** PostgreSQL connection configuration. Supports `connectionString`, `max` (pool size), `keepAlive`, and other [node-postgres pool options](https://node-postgres.com/apis/pool) |
| `stripeSecretKey` | string | **Required.** Your Stripe API secret key (starts with `sk_test_` or `sk_live_`) |
| `stripeWebhookSecret` | string | Optional. Stripe webhook signing secret for validating webhook signatures |
| `schema` | string | Optional. Database schema name. Default: `stripe` |
| `stripeApiVersion` | string | Optional. Stripe API version. Default: `2020-08-27` |
| `autoExpandLists` | boolean | Optional. Automatically fetch all items in paginated lists (instead of default 10). Default: `false` |
| `backfillRelatedEntities` | boolean | Optional. Ensure related entities exist for foreign key integrity. Default: `false` |
| `revalidateObjectsViaStripeApi` | string[] | Optional. Array of entity types to always fetch from Stripe API instead of trusting webhook payload. Possible values: `charge`, `credit_note`, `customer`, `dispute`, `invoice`, `payment_intent`, `payment_method`, `plan`, `price`, `product`, `refund`, `review`, `radar.early_fraud_warning`, `setup_intent`, `subscription`, `subscription_schedule`, `tax_id`, `entitlements` |
| `logger` | Logger | Optional. Pino logger instance for logging |
| `databaseUrl` | string | **Deprecated.** Use `poolConfig.connectionString` instead |
| `maxPostgresConnections` | number | **Deprecated.** Use `poolConfig.max` instead |

## Database Schema

The library will create and manage a `stripe` schema in your PostgreSQL database, with tables for all supported Stripe objects (products, customers, invoices, etc.).

### Migrations

Database migrations are automatically bundled with the package. Run them using the `runMigrations` function:

```typescript
import { runMigrations } from 'stripe-replit-sync'

await runMigrations({
  databaseUrl: 'postgres://user:pass@host:port/db',
  schema: 'stripe' // optional, defaults to 'stripe'
})
```

## Backfilling and Syncing Data

### Syncing a Single Entity

You can sync or update a single Stripe entity by its ID using the `syncSingleEntity` method:

```ts
await sync.syncSingleEntity('cus_12345')
```

The entity type is detected automatically based on the Stripe ID prefix (e.g., `cus_` for customer, `prod_` for product). `ent_` is not supported at the moment.

### Backfilling Data

To backfill Stripe data (e.g., all products created after a certain date), use the `syncBackfill` method:

```ts
await sync.syncBackfill({
  object: 'product',
  created: { gte: 1643872333 }, // Unix timestamp
})
```

- `object` can be one of: `all`, `charge`, `customer`, `dispute`, `invoice`, `payment_method`, `payment_intent`, `plan`, `price`, `product`, `setup_intent`, `subscription`.
- `created` is a Stripe RangeQueryParam and supports `gt`, `gte`, `lt`, `lte`.

> **Note:**
> For large Stripe accounts (more than 10,000 objects), it is recommended to write a script that loops through each day and sets the `created` date filters to the start and end of day. This avoids timeouts and memory issues when syncing large datasets.
