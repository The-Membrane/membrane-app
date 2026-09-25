// One-shot, additive DDL for TELEGRAM ADDRESS ALERTS (MOAT step 7, owner-approved
// 2026-09-25). Mirrors the `alertSubscriptions` / `alertDeliveries` /
// `alertBotState` drizzle definitions in db/schema.ts — keep them in lockstep.
//
//   node scripts/apply-alert-subscriptions-ddl.mjs     (from the membrane-app root)
//   pnpm telegram:ddl
//
// Applied manually (pet_wraps / venue_* / user_receipts precedent) instead of
// `drizzle-kit push` so a schema drift elsewhere can't turn this into a
// destructive diff. Reads DATABASE_URL_UNPOOLED (falls back to DATABASE_URL) from
// .env.local. Safe to re-run: everything is IF NOT EXISTS.

import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = readFileSync(join(root, '.env.local'), 'utf8')
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '')
const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED / DATABASE_URL in .env.local')
  process.exit(1)
}

const sql = neon(url)

// alert_subscriptions — one row per (Telegram chat, watched address). /stop sets
// stopped_at; a re-subscribe clears it and restarts created_at (no backfill of the
// stopped gap). The address must already be in strat_watches (checked by the bot).
await sql`CREATE TABLE IF NOT EXISTS alert_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  CONSTRAINT alert_subscriptions_chat_address_key UNIQUE (chat_id, address)
)`
await sql`CREATE INDEX IF NOT EXISTS alert_subscriptions_active_idx ON alert_subscriptions (address) WHERE stopped_at IS NULL`

// alert_deliveries — the idempotency ledger: a (subscription, alarm, moment) is
// sent at most once. Written only after Telegram returns ok.
await sql`CREATE TABLE IF NOT EXISTS alert_deliveries (
  subscription_id uuid NOT NULL REFERENCES alert_subscriptions(id) ON DELETE CASCADE,
  alarm_id uuid NOT NULL,
  moment text NOT NULL CHECK (moment IN ('fired', 'cleared')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, alarm_id, moment)
)`

// alert_bot_state — tiny key/value for the dev poller's getUpdates offset.
await sql`CREATE TABLE IF NOT EXISTS alert_bot_state (
  key text PRIMARY KEY,
  value text NOT NULL
)`

const [{ s }] = await sql`SELECT count(*)::int AS s FROM alert_subscriptions WHERE stopped_at IS NULL`
const [{ d }] = await sql`SELECT count(*)::int AS d FROM alert_deliveries`
console.log(`alert_subscriptions ready — active: ${s}; alert_deliveries: ${d}; alert_bot_state ready`)
