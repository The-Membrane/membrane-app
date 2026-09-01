// Server-side points-ledger helper for the app_points_ledger table (Phase 5).
// See docs/OFFCHAIN_QRACING_PLAN.md, Phase 5 ("Connect the database to the rest of
// the app"). Same philosophy as byte_ledger: append-only, balance = SUM(delta), never
// update or delete a row.
//
// This is a SEPARATE points namespace from the on-chain PointsSystem.sol / MBRN-claim
// points read in services/chain/points.ts and rendered in components/Nav/PointsLevel.tsx.
// That system is protocol-action points backing a real MBRN claim; this ledger is
// engagement points for the offchain game (race wins today, more sources land here
// incrementally — see GAME.POINTS_PER_RACE_WIN in lib/game/config.ts).

import { db } from '@/db'
import { appPointsLedger } from '@/db/schema'

if (typeof window !== 'undefined') {
  throw new Error('lib/game/points must never be imported from client-side code')
}

/**
 * Builds one append-only points credit. Returns the (un-awaited) Drizzle insert query —
 * this db client has no db.transaction, only db.batch, so callers choose how to run it:
 *   - `await awardPoints(...)` to execute it standalone (e.g. a future PvP/session-only
 *     award path), or
 *   - drop it un-awaited into a `db.batch([...])` array alongside other writes that must
 *     land atomically with it (see pages/api/game/race/submit.ts, which batches this with
 *     the race-row update and the byte_ledger credit).
 */
export function awardPoints(
  playerId: string,
  delta: bigint,
  reason: string,
  meta?: Record<string, unknown> | null,
) {
  return db.insert(appPointsLedger).values({
    playerId,
    delta,
    reason,
    meta: meta ?? null,
  })
}
