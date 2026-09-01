// Write seam for the on-chain result indexer. NOT an HTTP route on purpose: the chain
// indexer (to be built later against the lib/qgame ABIs — see config/evm/* /
// lib/qgame/* landing separately) runs as a server-side job (cron / worker) that reads
// events straight off-chain and calls these functions directly, in-process. A public
// POST /api/game/ingest would let anyone forge a leaderboard row with no signature to
// check it against, so that route deliberately does not exist. If the indexer ever runs
// out-of-process from the Next.js server, front these with an internal route guarded by
// a server-only shared secret — not a public endpoint.
//
// Both functions are idempotent on their table's unique key, so the indexer can safely
// replay a block range (e.g. after a crash) without double-counting.

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { dailyFirsts, onchainResults } from '@/db/schema'
import { cleanDisplayName } from '@/lib/game/cleanName'

if (typeof window !== 'undefined') {
  throw new Error('lib/game/indexerSeam must never be imported from client-side code')
}

/** Matches the `board` values GET /api/game/leaderboard understands for on-chain rows. */
export type OnchainBoard = 'ladder_time' | 'daily_time' | 'ghost_win' | 'byte_earned'

export type IngestOnchainResultInput = {
  wallet: string
  displayName?: string | null
  board: OnchainBoard
  /**
   * Board-typed magnitude:
   *  - ladder_time / daily_time: race duration in ticks (lower is better — same unit
   *    convention as the offchain `races.time_ticks` column).
   *  - ghost_win: 1 per win row (aggregated by the leaderboard query, not here).
   *  - byte_earned: raw 6-decimal BYTE units (same convention as `byte_ledger.delta`).
   */
  value: bigint
  meta?: Record<string, unknown> | null
  occurredAt: Date
  /** Required — see onchain_results_board_tx_hash_idx; this is the idempotency key. */
  txHash: string
}

/**
 * Idempotently inserts one on-chain leaderboard row. Safe to call more than once for the
 * same (board, txHash) — the second call is a no-op via ON CONFLICT DO NOTHING, so the
 * indexer does not need its own dedupe bookkeeping across restarts.
 *
 * `displayName` is run through cleanDisplayName here, at ingest — same path daily_firsts
 * uses. onchain_results has no separate raw/clean column pair (unlike daily_firsts), so
 * the sanitized string is what's stored; there is no raw copy to keep. This matters
 * beyond the ticker: every public leaderboard reader (GET /api/game/leaderboard) also
 * serves this column directly, including the 'daily_time' board that the ticker's
 * "fastest of the day" honor is sourced from.
 */
export async function ingestOnchainResult(input: IngestOnchainResultInput): Promise<void> {
  const wallet = input.wallet.trim()
  if (!wallet) throw new Error('ingestOnchainResult: wallet is required')
  if (!input.txHash) throw new Error('ingestOnchainResult: txHash is required (idempotency key)')
  if (input.value < 0n) throw new Error('ingestOnchainResult: value must be >= 0')

  const displayName = input.displayName != null ? cleanDisplayName(input.displayName).clean : null

  await db
    .insert(onchainResults)
    .values({
      wallet,
      displayName,
      board: input.board,
      value: input.value,
      meta: input.meta ?? null,
      occurredAt: input.occurredAt,
      txHash: input.txHash,
    })
    .onConflictDoNothing({ target: [onchainResults.board, onchainResults.txHash] })
}

export type IngestDailyFirstInput = {
  /** YYYY-MM-DD, UTC — the primary key. Caller derives this from the on-chain block timestamp. */
  day: string
  wallet?: string | null
  /** Raw, unmoderated name as read on-chain. Stored as-is for audit; never served publicly. */
  displayName: string
  occurredAt: Date
  txHash?: string | null
}

/**
 * Idempotently records the wallet that reached a given UTC day's daily-run finish line
 * first. `clean_name` is derived here, once, via cleanDisplayName — every public reader
 * (GET /api/game/ticker) serves clean_name only and never touches display_name.
 *
 * Idempotent on `day` (the primary key): ON CONFLICT DO NOTHING means the first indexer
 * write for a day wins and a replay cannot overwrite it with a later-observed row. If the
 * indexer needs to correct a wrongly-attributed day, that is a manual DB fix, not a
 * re-ingest — matches the "insert-only" trust posture used by byte_ledger elsewhere.
 */
export async function ingestDailyFirst(input: IngestDailyFirstInput): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) {
    throw new Error('ingestDailyFirst: day must be YYYY-MM-DD (UTC)')
  }

  const { clean } = cleanDisplayName(input.displayName)

  await db
    .insert(dailyFirsts)
    .values({
      day: input.day,
      wallet: input.wallet ?? null,
      displayName: input.displayName,
      cleanName: clean,
      occurredAt: input.occurredAt,
      txHash: input.txHash ?? null,
    })
    .onConflictDoNothing({ target: dailyFirsts.day })
}

// Re-exported for callers that want a raw idempotency check before doing indexer-side
// work (e.g. skip re-fetching event logs for a day that's already recorded).
export async function dailyFirstExists(day: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    select exists(select 1 from daily_firsts where day = ${day}) as exists
  `)
  return Boolean(rows.rows[0]?.exists)
}
