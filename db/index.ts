import { neon } from '@neondatabase/serverless'
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http'

import * as schema from './schema'

// Lazy singleton: DATABASE_URL is read at first *use*, not at import time, so the
// app (including routes that never touch the db) still builds and runs without it
// configured. Throwing here instead of at module load keeps a missing env var from
// breaking unrelated pages/build steps.
let _db: NeonHttpDatabase<typeof schema> | undefined

function getDb(): NeonHttpDatabase<typeof schema> {
  // Pages-router equivalent of the `server-only` package (which only works in the
  // app router): hard-fail if this module ever executes in a browser bundle.
  if (typeof window !== 'undefined') {
    throw new Error('db client must never be imported from client-side code')
  }
  if (_db) return _db

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Add it to your environment (see docs/OFFCHAIN_QRACING_PLAN.md, Phase 0) before using db.',
    )
  }

  const sql = neon(connectionString)
  _db = drizzle(sql, { schema })
  return _db
}

// Proxy so `db.query...` / `db.select()...` etc. keep working while the real
// client is only constructed (and DATABASE_URL only read) on first property access.
export const db: NeonHttpDatabase<typeof schema> = new Proxy({} as NeonHttpDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver)
  },
})
