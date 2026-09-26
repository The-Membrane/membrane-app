// One-shot, additive DDL for the pet_wraps table (Pocket GP car wraps).
// Applied manually (indexer_cursor precedent) instead of `drizzle-kit push` so
// a schema drift elsewhere can't turn this into a destructive diff.
//
//   node scripts/apply-pet-wraps-ddl.mjs        (from the membrane-app root)
//
// Reads DATABASE_URL_UNPOOLED (falls back to DATABASE_URL) from .env.local.
// Safe to re-run: everything is IF NOT EXISTS.

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
await sql`CREATE TABLE IF NOT EXISTS pet_wraps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL,
  token_id text NOT NULL,
  owner_address text NOT NULL,
  skin text NOT NULL,
  body text, accent text, glow text,
  updated_at timestamptz NOT NULL DEFAULT now()
)`
await sql`CREATE UNIQUE INDEX IF NOT EXISTS pet_wraps_chain_token_idx ON pet_wraps (chain_id, token_id)`
await sql`CREATE INDEX IF NOT EXISTS pet_wraps_owner_idx ON pet_wraps (owner_address)`
const [{ n }] = await sql`SELECT count(*)::int AS n FROM pet_wraps`
console.log(`pet_wraps ready (rows: ${n})`)

// Launch-gate checklist — this script is re-run against prod Neon at launch,
// which makes it the tripwire for the wrap vault's other two gates:
console.log(`
WRAP-VAULT LAUNCH GATES (memory: pgp-wrap-launch-gates):
  [ ] PGP_NFT_ADDRESS set in this deployment's server env (Vercel) to the live
      PetNFT address — unset means publishing is signature-only, NOT ownerOf-
      gated, so anyone with a key can dress any token id. Redeploy after setting.
  [ ] The game's window.WRAP_API points at THIS deployment's origin
      (/api/game/wrap). Its in-code default is http://localhost:3005 — dev only.
  [ ] NEXT_PUBLIC_EVM_CHAIN_ID / NEXT_PUBLIC_EVM_RPC_URL are the production
      chain — pet_wraps rows are keyed by (chain_id, token_id).
  [ ] If the PetNFT contract was REdeployed on the same chain, token ids
      restarted: truncate or migrate pet_wraps, or old wraps dress new pets.
`)
