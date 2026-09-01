import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

// PUBLIC — no requirePlayer(). Plain SQL via db.execute (no DB views) per Phase 5 of
// docs/OFFCHAIN_QRACING_PLAN.md, keeping `drizzle-kit push` simple.
//
// Two worlds feed this route now: the offchain practice game (races / byte_ledger,
// unchanged) and the on-chain game, indexed into onchain_results / daily_firsts by
// lib/game/indexerSeam.ts (chain indexer lands separately). `top_times` and `ghost`
// return one merged/aggregated `entries` list; `byte_earned` returns two independent
// lists (`onchain` / `practice`) because BYTE-on-chain and practice BYTE are different
// currencies and must never be summed together; `daily` groups by UTC day.

export type LeaderboardBoard = 'top_times' | 'byte_earned' | 'daily' | 'ghost'
export type LeaderboardSource = 'all' | 'onchain' | 'practice'

export type LeaderboardEntry = {
  source: 'onchain' | 'practice'
  /** 1-based rank counting on-chain rows only. Practice rows are always null — the UI
   *  renders them with a `*` and places them inline by value, not officially ranked. */
  rank: number | null
  /** wallet address for on-chain rows, players.id for practice rows. */
  id: string
  displayName: string | null
  /** Board-typed magnitude as a string (ticks, win count, or raw 6-decimal BYTE units). */
  value: string
  occurredAt?: string | null
}

export type DailyBoardDay = {
  day: string // YYYY-MM-DD, UTC
  first: {
    wallet: string | null
    displayName: string
    occurredAt: string
    txHash: string | null
  } | null
  entries: LeaderboardEntry[]
}

export type LeaderboardResult =
  | { board: 'top_times' | 'ghost'; source: LeaderboardSource; entries: LeaderboardEntry[] }
  | {
      board: 'byte_earned'
      source: LeaderboardSource
      onchain: LeaderboardEntry[]
      practice: LeaderboardEntry[]
    }
  | { board: 'daily'; source: LeaderboardSource; days: DailyBoardDay[] }
  | { error: string }

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const DEFAULT_DAYS = 14
const MAX_DAYS = 30

function parseLimit(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

function parseBoard(raw: unknown): LeaderboardBoard {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v === 'byte_earned' || v === 'daily' || v === 'ghost') return v
  return 'top_times'
}

function parseSource(raw: unknown): LeaderboardSource {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v === 'onchain' || v === 'practice') return v
  return 'all'
}

// Assigns rank 1..n counting only 'onchain' rows; 'practice' rows get rank null and
// keep their sorted position (the UI shows them with a `*`). Input must already be
// sorted best-first for the board (ascending for time boards, descending for count
// boards) — this function only assigns ranks, it never re-sorts.
function assignRanks(sorted: LeaderboardEntry[]): LeaderboardEntry[] {
  let nextRank = 1
  return sorted.map((entry) => {
    if (entry.source !== 'onchain') return { ...entry, rank: null }
    return { ...entry, rank: nextRank++ }
  })
}

async function fetchPracticeTopTimes(limit: number): Promise<LeaderboardEntry[]> {
  const rows = await db.execute<{
    player_id: string
    username: string | null
    time_ticks: number
  }>(sql`
    select p.id as player_id, p.username, r.min_ticks as time_ticks
    from (
      select player_id, min(time_ticks) as min_ticks
      from races
      where verified = true and time_ticks is not null
      group by player_id
    ) r
    join players p on p.id = r.player_id
    order by r.min_ticks asc
    limit ${limit}
  `)
  return rows.rows.map((r) => ({
    source: 'practice' as const,
    rank: null,
    id: r.player_id,
    displayName: r.username,
    value: String(r.time_ticks),
  }))
}

async function fetchOnchainTopTimes(limit: number): Promise<LeaderboardEntry[]> {
  const rows = await db.execute<{
    wallet: string
    display_name: string | null
    min_value: string
  }>(sql`
    select wallet, max(display_name) as display_name, min(value) as min_value
    from onchain_results
    where board = 'ladder_time'
    group by wallet
    order by min_value asc
    limit ${limit}
  `)
  return rows.rows.map((r) => ({
    source: 'onchain' as const,
    rank: null, // assigned by assignRanks after merge
    id: r.wallet,
    displayName: r.display_name,
    value: String(r.min_value),
  }))
}

async function fetchPracticeByteEarned(limit: number): Promise<LeaderboardEntry[]> {
  const rows = await db.execute<{ player_id: string; username: string | null; total: string }>(sql`
    select p.id as player_id, p.username, coalesce(sum(b.delta), 0) as total
    from byte_ledger b
    join players p on p.id = b.player_id
    where b.delta > 0
    group by p.id, p.username
    order by total desc
    limit ${limit}
  `)
  // rank stays null — practice rows are always rendered as `*`, never a numeric rank.
  return rows.rows.map((r) => ({
    source: 'practice' as const,
    rank: null,
    id: r.player_id,
    displayName: r.username,
    value: String(r.total),
  }))
}

async function fetchOnchainByteEarned(limit: number): Promise<LeaderboardEntry[]> {
  const rows = await db.execute<{ wallet: string; display_name: string | null; total: string }>(sql`
    select wallet, max(display_name) as display_name, coalesce(sum(value), 0) as total
    from onchain_results
    where board = 'byte_earned'
    group by wallet
    order by total desc
    limit ${limit}
  `)
  return rows.rows.map((r, i) => ({
    source: 'onchain' as const,
    rank: i + 1,
    id: r.wallet,
    displayName: r.display_name,
    value: String(r.total),
  }))
}

async function fetchGhost(limit: number): Promise<LeaderboardEntry[]> {
  const rows = await db.execute<{ wallet: string; display_name: string | null; wins: string }>(sql`
    select wallet, max(display_name) as display_name, count(*) as wins
    from onchain_results
    where board = 'ghost_win'
    group by wallet
    order by wins desc
    limit ${limit}
  `)
  return rows.rows.map((r, i) => ({
    source: 'onchain' as const,
    rank: i + 1,
    id: r.wallet,
    displayName: r.display_name,
    value: String(r.wins),
  }))
}

async function fetchDaily(days: number, perDayLimit: number): Promise<DailyBoardDay[]> {
  const [firstsRows, timeRows] = await Promise.all([
    db.execute<{
      day: string
      wallet: string | null
      clean_name: string
      occurred_at: string
      tx_hash: string | null
    }>(sql`
      select day, wallet, clean_name, occurred_at, tx_hash
      from daily_firsts
      order by day desc
      limit ${days}
    `),
    db.execute<{ day: string; wallet: string; display_name: string | null; min_value: string }>(sql`
      select to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day,
             wallet,
             max(display_name) as display_name,
             min(value) as min_value
      from onchain_results
      where board = 'daily_time'
      group by to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD'), wallet
      order by day desc, min_value asc
    `),
  ])

  const firstsByDay = new Map(
    firstsRows.rows.map((r) => [
      r.day,
      { wallet: r.wallet, displayName: r.clean_name, occurredAt: r.occurred_at, txHash: r.tx_hash },
    ]),
  )

  const entriesByDay = new Map<string, LeaderboardEntry[]>()
  for (const r of timeRows.rows) {
    const list = entriesByDay.get(r.day) ?? []
    if (list.length < perDayLimit) {
      list.push({
        source: 'onchain',
        rank: null,
        id: r.wallet,
        displayName: r.display_name,
        value: String(r.min_value),
      })
    }
    entriesByDay.set(r.day, list)
  }

  const allDays = new Set<string>([...firstsByDay.keys(), ...entriesByDay.keys()])
  const orderedDays = Array.from(allDays)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, days)

  return orderedDays.map((day) => ({
    day,
    first: firstsByDay.get(day) ?? null,
    entries: assignRanks(entriesByDay.get(day) ?? []),
  }))
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LeaderboardResult>,
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const board = parseBoard(req.query.board)
  const source = parseSource(req.query.source)
  const limit = parseLimit(req.query.limit)

  // Public + cacheable — a stale-by-30s leaderboard is fine and keeps this route cheap
  // under repeated polling.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60')

  try {
    if (board === 'byte_earned') {
      const [onchain, practice] = await Promise.all([
        source === 'practice' ? Promise.resolve([]) : fetchOnchainByteEarned(limit),
        source === 'onchain' ? Promise.resolve([]) : fetchPracticeByteEarned(limit),
      ])
      // Practice rows always carry rank: null (rendered as `*` by the UI) — same rule as
      // every other board, even though this list isn't merged with the on-chain one.
      return res.status(200).json({ board, source, onchain, practice })
    }

    if (board === 'daily') {
      const days = source === 'onchain' || source === 'all' ? DEFAULT_DAYS : 0
      const dayRows = days > 0 ? await fetchDaily(Math.min(days, MAX_DAYS), limit) : []
      return res.status(200).json({ board, source, days: dayRows })
    }

    if (board === 'ghost') {
      const entries = source === 'practice' ? [] : await fetchGhost(limit)
      return res.status(200).json({ board, source, entries })
    }

    // top_times
    const [practiceEntries, onchainEntries] = await Promise.all([
      source === 'onchain' ? Promise.resolve([]) : fetchPracticeTopTimes(limit),
      source === 'practice' ? Promise.resolve([]) : fetchOnchainTopTimes(limit),
    ])
    const merged = [...onchainEntries, ...practiceEntries].sort(
      (a, b) => Number(a.value) - Number(b.value),
    )
    const ranked = assignRanks(merged).slice(0, limit)
    return res.status(200).json({ board, source, entries: ranked })
  } catch {
    return res.status(500).json({ error: 'leaderboard_load_failed' })
  }
}
