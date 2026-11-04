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

// EVERY constraint and index is NAMED, and each name matches the drizzle mirror in
// db/schema.ts (Postgres-convention: <table>_pkey, <table>_<column>_fkey, …).

// user_alert_owners — one row per FEED. feed_token (32 random bytes, hex) is the
// capability for reading that feed and the only key any read path accepts. No index
// on owner_key: no query may look thresholds up by address.
await sql`CREATE TABLE IF NOT EXISTS user_alert_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL,
  owner_key text NOT NULL,
  feed_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_alert_owners_kind_check CHECK (owner_kind IN ('address', 'telegram')),
  CONSTRAINT user_alert_owners_feed_token_key UNIQUE (feed_token)
)`

// user_alert_thresholds — one opt-in threshold. crossed_at is the start of the
// current crossing (NULL = not crossed); last_as_of is the as-of of the reading the
// state last moved on (writes require last_as_of <= the new reading's as-of). The
// API caps an owner at 25 active rows.
await sql`CREATE TABLE IF NOT EXISTS user_alert_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  metric text NOT NULL,
  subject text NOT NULL,
  direction text NOT NULL,
  threshold numeric NOT NULL,
  opted_in_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  last_value numeric,
  last_evaluated_at timestamptz,
  last_as_of timestamptz,
  crossed_at timestamptz,
  CONSTRAINT user_alert_thresholds_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES user_alert_owners(id) ON DELETE CASCADE,
  CONSTRAINT user_alert_thresholds_metric_check CHECK (metric IN ('price', 'utilization', 'apr')),
  CONSTRAINT user_alert_thresholds_direction_check CHECK (direction IN ('above', 'below'))
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_thresholds_owner_idx ON user_alert_thresholds (owner_id)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_thresholds_owner_active_idx ON user_alert_thresholds (owner_id) WHERE stopped_at IS NULL`

// user_alert_events — one row per crossed/cleared transition, written on read.
// UNIQUE (threshold_id, kind, crossing_at): each transition lands once.
await sql`CREATE TABLE IF NOT EXISTS user_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  threshold_id uuid NOT NULL,
  kind text NOT NULL,
  value numeric NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  as_of timestamptz NOT NULL,
  source text NOT NULL,
  crossing_at timestamptz NOT NULL,
  CONSTRAINT user_alert_events_threshold_id_fkey FOREIGN KEY (threshold_id) REFERENCES user_alert_thresholds(id) ON DELETE CASCADE,
  CONSTRAINT user_alert_events_kind_check CHECK (kind IN ('crossed', 'cleared')),
  CONSTRAINT user_alert_events_transition_key UNIQUE (threshold_id, kind, crossing_at)
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_events_threshold_at_idx ON user_alert_events (threshold_id, at)`

// user_alert_chat_links — a Telegram chat linked to a feed via /start th_<token>.
// Only written once TELEGRAM_ALERTS_WEBHOOK_SECRET is set (the bot ships dark).
await sql`CREATE TABLE IF NOT EXISTS user_alert_chat_links (
  owner_id uuid NOT NULL,
  chat_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  CONSTRAINT user_alert_chat_links_pkey PRIMARY KEY (owner_id, chat_id),
  CONSTRAINT user_alert_chat_links_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES user_alert_owners(id) ON DELETE CASCADE
)`
await sql`CREATE INDEX IF NOT EXISTS user_alert_chat_links_chat_active_idx ON user_alert_chat_links (chat_id) WHERE stopped_at IS NULL`

// user_alert_deliveries — the Telegram idempotency ledger: an (event, chat) is
// sent at most once (claimed before the send, released if it fails).
await sql`CREATE TABLE IF NOT EXISTS user_alert_deliveries (
  event_id uuid NOT NULL,
  chat_id text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_alert_deliveries_pkey PRIMARY KEY (event_id, chat_id),
  CONSTRAINT user_alert_deliveries_event_id_fkey FOREIGN KEY (event_id) REFERENCES user_alert_events(id) ON DELETE CASCADE
)`

// RECONCILE a database that ran the FIRST version of this script (IF NOT EXISTS
// above skipped its tables). That version's inline constraints got Postgres's own
// names, which already equal the names above — except the owner_kind CHECK
// (auto-named user_alert_owners_owner_kind_check). It also lacked last_as_of and
// the plain owner index, and had a by-address index that no query may use.
await sql`ALTER TABLE user_alert_thresholds ADD COLUMN IF NOT EXISTS last_as_of timestamptz`
await sql`DROP INDEX IF EXISTS user_alert_owners_owner_idx`
await sql`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_alert_owners_owner_kind_check') THEN
    ALTER TABLE user_alert_owners RENAME CONSTRAINT user_alert_owners_owner_kind_check TO user_alert_owners_kind_check;
  END IF;
END $$`

// Counts only — never a threshold next to an owner.
const [{ o }] = await sql`SELECT count(*)::int AS o FROM user_alert_owners`
const [{ t }] = await sql`SELECT count(*)::int AS t FROM user_alert_thresholds WHERE stopped_at IS NULL`
console.log(`user alert tables ready — feeds: ${o}; active thresholds: ${t}`)
