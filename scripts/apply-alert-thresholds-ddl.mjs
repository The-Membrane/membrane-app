// One-shot, additive DDL for USER THRESHOLD ALERTS ("Alert me at X",
// docs/USER_ALERTS.md). Mirrors the `userAlertOwners` / `userAlertThresholds` /
// `userAlertEvents` / `userAlertChatLinks` / `userAlertDeliveries` drizzle
// definitions in db/schema.ts — keep them in lockstep.
//
//   node scripts/apply-alert-thresholds-ddl.mjs     (from the membrane-app root)
//   pnpm alerts:ddl
//
// OWNER RUNS THIS. Applied manually (alert_subscriptions / venue_* / user_receipts
// precedent) instead of `drizzle-kit push` so a schema drift elsewhere can't turn
// this into a destructive diff. Reads DATABASE_URL_UNPOOLED (falls back to
// DATABASE_URL) from .env.local. Safe to re-run: everything is IF NOT EXISTS.
// Until it has run, GET /api/alerts/status answers storage:false and the
// "Alert me at" control stays hidden.

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

// user_alert_owners — one row per FEED. feed_token (32 random bytes, hex) is the
// capability for reading that feed and the only key any read path accepts.
await sql`CREATE TABLE IF NOT EXISTS user_alert_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL CHECK (owner_kind IN ('address', 'telegram')),
  owner_key text NOT NULL,
  feed_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_alert_owners_feed_token_key UNIQUE (feed_token)
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_owners_owner_idx ON user_alert_owners (owner_kind, owner_key)`

// user_alert_thresholds — one opt-in threshold. crossed_at is the start of the
// current crossing (NULL = not crossed); the API caps an owner at 25 active rows.
await sql`CREATE TABLE IF NOT EXISTS user_alert_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES user_alert_owners(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('price', 'utilization', 'apr')),
  subject text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('above', 'below')),
  threshold numeric NOT NULL,
  opted_in_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  last_value numeric,
  last_evaluated_at timestamptz,
  crossed_at timestamptz
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_thresholds_owner_active_idx ON user_alert_thresholds (owner_id) WHERE stopped_at IS NULL`

// user_alert_events — one row per crossed/cleared transition, written on read.
// UNIQUE (threshold_id, kind, crossing_at): each transition lands once.
await sql`CREATE TABLE IF NOT EXISTS user_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  threshold_id uuid NOT NULL REFERENCES user_alert_thresholds(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('crossed', 'cleared')),
  value numeric NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  as_of timestamptz NOT NULL,
  source text NOT NULL,
  crossing_at timestamptz NOT NULL,
  CONSTRAINT user_alert_events_transition_key UNIQUE (threshold_id, kind, crossing_at)
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_events_threshold_at_idx ON user_alert_events (threshold_id, at)`

// user_alert_chat_links — a Telegram chat linked to a feed via /start th_<token>.
// Only written once TELEGRAM_ALERTS_WEBHOOK_SECRET is set (the bot ships dark).
await sql`CREATE TABLE IF NOT EXISTS user_alert_chat_links (
  owner_id uuid NOT NULL REFERENCES user_alert_owners(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  PRIMARY KEY (owner_id, chat_id)
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_chat_links_chat_active_idx ON user_alert_chat_links (chat_id) WHERE stopped_at IS NULL`

// user_alert_deliveries — the Telegram idempotency ledger: an (event, chat) is
// sent at most once (claimed before the send, released if it fails).
await sql`CREATE TABLE IF NOT EXISTS user_alert_deliveries (
  event_id uuid NOT NULL REFERENCES user_alert_events(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, chat_id)
)`

// Counts only — never a threshold next to an owner.
const [{ o }] = await sql`SELECT count(*)::int AS o FROM user_alert_owners`
const [{ t }] = await sql`SELECT count(*)::int AS t FROM user_alert_thresholds WHERE stopped_at IS NULL`
console.log(`user alert tables ready — feeds: ${o}; active thresholds: ${t}`)
