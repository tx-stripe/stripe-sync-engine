#!/bin/bash
set -e

cd ../..
pnpm install --frozen-lockfile
pnpm --filter stripe-experiment-sync run build
pnpm --filter @supabase/stripe-sync-fastify run build
pnpm --filter @supabase/stripe-sync-cli run build
pnpm --filter @supabase/stripe-sync-dashboard run build
