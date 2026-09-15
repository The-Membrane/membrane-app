// One-shot, additive DDL for the LANDING H1 TEST event log (owner ruling
// 2026-09-15). One table mirroring the drizzle definition in db/schema.ts:
//   landing_events — insert-only conversions for the landing headline test
//
//   node scripts/apply-landing-events-ddl.mjs        (from the membrane-app root)
//
// Applied manually (venue recorder / pet_wraps precedent) instead of
// `drizzle-kit push` so a schema drift elsewhere can't turn this into a
// destructive diff. Reads DATABASE_URL_UNPOOLED (falls back to DATABASE_URL)
// from .env.local. Safe to re-run: everything is IF NOT EXISTS.
//
// tsx/node get NO Next env injection — .env.local is parsed by hand below.

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

// landing_events — the LANDING H1 TEST event log. The landing page renders one of
// two headlines, B or C, picked server-side by lib/landingVariant.ts and persisted
// per browser in the membrane.landingVariant cookie. This table holds the ONE
// conversion the test scores: a real address run in the hero simulator, stamped with
// the variant that was on screen above it. Page views are deliberately absent —
// impressions cannot answer "which headline gets a stranger to run their own wallet".
//
// PRIVACY: the address is never stored. address_hash is sha256 of the checksummed
// address (enough to count distinct runners and dedupe), ua_hash is sha256 of the
// user agent and exists only for the rate limit. No IP, no wallet, no clear address.
//
// INSERT-ONLY. Written by pages/api/landing/event.ts. Mirrors landingEvents in
// db/schema.ts — keep them in lockstep.
await sql`CREATE TABLE IF NOT EXISTS landing_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  variant text NOT NULL,
  kind text NOT NULL,
  chain text,
  address_hash text,
  source text,
  referrer text,
  ua_hash text
)`
await sql`CREATE INDEX IF NOT EXISTS landing_events_variant_at_idx ON landing_events (variant, at)`
await sql`CREATE INDEX IF NOT EXISTS landing_events_kind_at_idx ON landing_events (kind, at)`

const [{ e }] = await sql`SELECT count(*)::int AS e FROM landing_events`
const rows = await sql`SELECT variant, kind, count(*)::int AS n FROM landing_events GROUP BY variant, kind ORDER BY variant, kind`
console.log(`landing_events ready — rows: ${e}`)
for (const r of rows) console.log(`  ${r.variant} / ${r.kind}: ${r.n}`)
