// Chain-event indexer for Q-Racing. Reads PocketGP / Standings result events straight
// off the EVM chain (default anvil, chain 31337) and writes leaderboard rows through
// lib/game/indexerSeam.ts — the only write path into onchain_results / daily_firsts.
// Triggered opportunistically at the top of GET /api/game/leaderboard and
// GET /api/game/ticker (see indexNewEvents() usage there), not as a standalone worker,
// so it must stay cheap: throttled to ~once/60s and capped at ~3s wall-clock per call.
//
// ---------------------------------------------------------------------------------
// Board mapping (event -> lib/game/indexerSeam.ts OnchainBoard) — re-verified against
// the current membrane-solidity sources (a concurrent agent may be touching PocketGP's
// daily-seed internals; event SHAPES below were re-read from source, not assumed):
//
//  'ladder_time' <- Standings.NewRecord(uint8 indexed tier, address indexed who, uint16
//    steps)  [Standings.sol:16, emitted Standings.sol:34/40]. Fires ONLY when a race
//    improves the player's personal best on that tier's board — not on every finish
//    (Standings.submit, Standings.sol:26-41). value = steps (uint16; lower is better,
//    same ORDER BY value ASC convention pages/api/game/leaderboard.ts already uses for
//    this board).
//
//  'daily_time'  <- PocketGP.DailyRun(address indexed player, uint32 day, bool finished,
//    uint8 rank)  [PocketGP.sol:345, emitted unconditionally PocketGP.sol:815 — every
//    attempt, finished or not]. Only finished === true rows are ingested. IMPORTANT
//    DEVIATION: this event does NOT carry a tick/step count — _runDaily's internal
//    `steps` local (PocketGP.sol:782,801-802) is computed but never emitted — so `rank`
//    (uint8, 0 = win/first place) is used as the board value instead of ticks. rank is
//    still ascending-is-better, so it sorts consistently with ladder_time's steps under
//    the same "ORDER BY value ASC" the leaderboard route uses. If PocketGP.sol ever
//    starts emitting a real tick count, swap `rank` for it here.
//
//  'ghost_win'   <- PocketGP.GhostChallenge(address indexed player, uint8 tier, uint256
//    stake, uint16 multPct, bool won, bool paidToday)  [PocketGP.sol:342, emitted on
//    every settleGhost() call PocketGP.sol:718 — win or loss]. Only rows with
//    won && paidToday are ingested (a settlement that actually minted a payout — see
//    PocketGP.sol:708-717; `paidToday` guards the once-a-day payout slot, so a genuine
//    win can still carry paidToday === false if the day's slot was already spent).
//    value = payout = stake * multPct / 100n — the event carries the multiplier and
//    stake but no precomputed payout figure, so it is derived here exactly as
//    PocketGP.sol:715 (`token.mint(player, stake * multPct / 100)`) computes it.
//
// None of these three events carries a petId (confirmed by reading PocketGP.sol /
// Standings.sol directly), so the "pet name via PetLens" branch documented in the task
// is unreachable today — every row's displayName is the short-wallet form (see
// shortWallet() below) across all boards, including daily_firsts.
// ---------------------------------------------------------------------------------
//
// Cursor + throttle: one row in indexer_cursor (key = 'qgame') tracks the last fully
// scanned block and a claim timestamp. A run must win an atomic DB claim (INSERT ...
// ON CONFLICT DO UPDATE ... WHERE last_run is null or stale) before doing any chain
// work — see claimCursor(). A fast in-process module-scope guard (`lastAttemptAt`)
// short-circuits repeat calls within the same warm serverless instance without even
// hitting the DB. Together these cap the indexer to ~once/60s regardless of how many
// instances / how often the two API routes are hit.
//
// indexer_cursor is NOT pushed via `drizzle-kit push` (see db/schema.ts). The
// equivalent DDL, applied directly against dev for this feature to run at all:
//
//   CREATE TABLE IF NOT EXISTS "indexer_cursor" (
//     "key" text PRIMARY KEY NOT NULL,
//     "block" bigint DEFAULT 0 NOT NULL,
//     "last_run" timestamp with time zone
//   );

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'
import { getContractAddress } from '@/config/evm/contracts'
import { getPublicClient } from '@/services/chain/client'
import { pocketGPAbi, standingsAbi } from '@/lib/qgame/abi'
import { ingestOnchainResult, ingestDailyFirst, dailyFirstExists } from '@/lib/game/indexerSeam'

if (typeof window !== 'undefined') {
  throw new Error('lib/game/chainIndexer must never be imported from client-side code')
}

const CURSOR_KEY = 'qgame'
const THROTTLE_MS = 60_000
const WALL_CLOCK_CAP_MS = 3_000
const DEFAULT_MAX_BLOCKS = 5_000

/** `0x1234…abcd` — the only display name any board can show; see header comment. */
export function shortWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** PocketGP's `today()` day index (days since epoch) -> 'YYYY-MM-DD' UTC. */
export function dayIndexToUtcDateString(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

export type IndexCounts = {
  ladder_time: number
  daily_time: number
  ghost_win: number
  daily_firsts: number
}

export type IndexResult =
  | { skipped: true; reason: 'in-memory-throttle' | 'db-throttle' | 'no-deployment' }
  | { skipped: false; fromBlock: bigint; toBlock: bigint; counts: IndexCounts }

const ZERO_COUNTS: IndexCounts = { ladder_time: 0, daily_time: 0, ghost_win: 0, daily_firsts: 0 }

// Fast in-process guard — persists across warm invocations of the same serverless
// instance, avoiding a DB round trip entirely for the common case of two routes on the
// same instance both firing indexNewEvents() within the same 60s window.
let lastAttemptAt = 0

/**
 * Atomically claims the cursor row for this run, returning the last-scanned block if
 * this call won the claim, or null if another run (this instance or another) already
 * claimed within the throttle window. Losers must return silently, not retry — the
 * whole point is that a caller (an API route handler) can `.catch(() => {})` this and
 * move on.
 */
async function claimCursor(): Promise<bigint | null> {
  const rows = await db.execute<{ block: string }>(sql`
    insert into indexer_cursor (key, block, last_run)
    values (${CURSOR_KEY}, 0, now())
    on conflict (key) do update
      set last_run = now()
      where indexer_cursor.last_run is null
         or indexer_cursor.last_run < now() - interval '60 seconds'
    returning block
  `)
  if (rows.rows.length === 0) return null
  return BigInt(rows.rows[0].block)
}

async function saveCursor(block: bigint): Promise<void> {
  await db.execute(sql`
    update indexer_cursor set block = ${block.toString()}::bigint where key = ${CURSOR_KEY}
  `)
}

type MergedLog = {
  eventName: 'DailyRun' | 'GhostChallenge' | 'NewRecord'
  blockNumber: bigint
  logIndex: number
  transactionHash: `0x${string}`
  args: Record<string, unknown>
}

/**
 * Scans at most `maxBlocks` new blocks since the cursor and ingests any ladder / daily /
 * ghost result events found, plus any resulting daily_firsts row. Safe to call as often
 * as you like — throttling and idempotency make repeat/concurrent calls no-ops.
 */
export async function indexNewEvents(maxBlocks = DEFAULT_MAX_BLOCKS): Promise<IndexResult> {
  const now = Date.now()
  if (now - lastAttemptAt < THROTTLE_MS) {
    return { skipped: true, reason: 'in-memory-throttle' }
  }
  lastAttemptAt = now

  const chain = DEFAULT_EVM_CHAIN
  const pocketGP = getContractAddress(chain.id, 'qgamePocketGP')
  const standings = getContractAddress(chain.id, 'qgameStandings')
  if (!pocketGP || !standings) {
    return { skipped: true, reason: 'no-deployment' }
  }

  const cursorBlock = await claimCursor()
  if (cursorBlock === null) {
    return { skipped: true, reason: 'db-throttle' }
  }

  const deadline = Date.now() + WALL_CLOCK_CAP_MS
  const client = getPublicClient(chain)

  const latest = await client.getBlockNumber()
  const fromBlock = cursorBlock + 1n
  if (fromBlock > latest) {
    // Nothing new since the last scan — cursor already reflects "latest".
    return { skipped: false, fromBlock, toBlock: cursorBlock, counts: ZERO_COUNTS }
  }
  const maxSpan = BigInt(Math.max(1, maxBlocks)) - 1n
  const toBlock = latest < fromBlock + maxSpan ? latest : fromBlock + maxSpan

  const [pocketGPLogs, standingsLogs] = await Promise.all([
    client.getContractEvents({ address: pocketGP, abi: pocketGPAbi, fromBlock, toBlock }),
    client.getContractEvents({ address: standings, abi: standingsAbi, fromBlock, toBlock }),
  ])

  const merged: MergedLog[] = [...pocketGPLogs, ...standingsLogs]
    .filter(
      (l): l is typeof l & { eventName: MergedLog['eventName'] } =>
        l.eventName === 'DailyRun' || l.eventName === 'GhostChallenge' || l.eventName === 'NewRecord',
    )
    .map((l) => ({
      eventName: l.eventName,
      blockNumber: l.blockNumber as bigint,
      logIndex: l.logIndex as number,
      transactionHash: l.transactionHash as `0x${string}`,
      args: l.args as Record<string, unknown>,
    }))
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    )

  const uniqueBlocks = Array.from(new Set(merged.map((m) => m.blockNumber)))
  const blockTimestamps = new Map<bigint, Date>()
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      const block = await client.getBlock({ blockNumber: bn })
      blockTimestamps.set(bn, new Date(Number(block.timestamp) * 1000))
    }),
  )

  const counts: IndexCounts = { ladder_time: 0, daily_time: 0, ghost_win: 0, daily_firsts: 0 }
  let committedBlock = cursorBlock
  let currentGroupBlock: bigint | null = null
  let brokeEarly = false

  for (const log of merged) {
    if (currentGroupBlock !== null && log.blockNumber !== currentGroupBlock) {
      // The previous block's whole log group finished processing — safe to commit it.
      committedBlock = currentGroupBlock
    }
    currentGroupBlock = log.blockNumber

    if (Date.now() > deadline) {
      brokeEarly = true
      break
    }

    const occurredAt = blockTimestamps.get(log.blockNumber) ?? new Date()

    if (log.eventName === 'DailyRun') {
      const { player, day, finished, rank } = log.args as {
        player: `0x${string}`
        day: number
        finished: boolean
        rank: number
      }
      if (!finished) continue

      await ingestOnchainResult({
        wallet: player,
        displayName: shortWallet(player),
        board: 'daily_time',
        value: BigInt(rank),
        meta: { day, rank },
        occurredAt,
        txHash: log.transactionHash,
      })
      counts.daily_time++

      const dayStr = dayIndexToUtcDateString(day)
      if (!(await dailyFirstExists(dayStr))) {
        await ingestDailyFirst({
          day: dayStr,
          wallet: player,
          displayName: shortWallet(player),
          occurredAt,
          txHash: log.transactionHash,
        })
        counts.daily_firsts++
      }
    } else if (log.eventName === 'GhostChallenge') {
      const { player, tier, stake, multPct, won, paidToday } = log.args as {
        player: `0x${string}`
        tier: number
        stake: bigint
        multPct: number
        won: boolean
        paidToday: boolean
      }
      if (!(won && paidToday)) continue

      const payout = (stake * BigInt(multPct)) / 100n
      await ingestOnchainResult({
        wallet: player,
        displayName: shortWallet(player),
        board: 'ghost_win',
        value: payout,
        meta: { tier, stake: stake.toString(), multPct },
        occurredAt,
        txHash: log.transactionHash,
      })
      counts.ghost_win++
    } else if (log.eventName === 'NewRecord') {
      const { tier, who, steps } = log.args as { tier: number; who: `0x${string}`; steps: number }

      await ingestOnchainResult({
        wallet: who,
        displayName: shortWallet(who),
        board: 'ladder_time',
        value: BigInt(steps),
        meta: { tier },
        occurredAt,
        txHash: log.transactionHash,
      })
      counts.ladder_time++
    }
  }

  if (!brokeEarly) {
    // Consumed every log in [fromBlock, toBlock] within budget -> the whole range is
    // fully scanned, including any blocks with zero matching events.
    committedBlock = toBlock
  }
  // Else: committedBlock stays at the last block whose entire log group finished before
  // the deadline hit. The interrupted block (and everything after it, up to toBlock) is
  // re-scanned next run — safe, since every write above is idempotent on its unique key.

  if (committedBlock > cursorBlock) {
    await saveCursor(committedBlock)
  }

  return { skipped: false, fromBlock, toBlock, counts }
}
