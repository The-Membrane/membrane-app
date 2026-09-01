import type { NextApiRequest, NextApiResponse } from 'next'
import { desc, sql } from 'drizzle-orm'

import { db } from '@/db'
import { dailyFirsts } from '@/db/schema'

// PUBLIC — feeds components/Ticker/DailyFirstTicker.tsx. Two honors per UTC day, both
// sourced from the daily race:
//   - 'first'   — first wallet through the day's finish line (daily_firsts).
//   - 'fastest' — current fastest run of the day (min-value 'daily_time' row in
//     onchain_results). Can change intraday as faster runs land; this always serves the
//     current best, not the first-observed best.
// Both kinds carry clean_name only — daily_firsts.clean_name and onchain_results
// .display_name are both sanitized via cleanDisplayName at ingest (see
// lib/game/indexerSeam.ts), never the raw wallet-chosen string.

export type TickerItemKind = 'first' | 'fastest'

export type TickerItem = {
  kind: TickerItemKind
  day: string // YYYY-MM-DD, UTC
  cleanName: string
  occurredAt: string
  /** ticks — present only for kind: 'fastest'. */
  value?: string
}

export type TickerResult = { items: TickerItem[] } | { error: string }

const DAY_COUNT = 14

export default async function handler(req: NextApiRequest, res: NextApiResponse<TickerResult>) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120')

  try {
    const [firstsRows, fastestRows] = await Promise.all([
      db
        .select({
          day: dailyFirsts.day,
          cleanName: dailyFirsts.cleanName,
          occurredAt: dailyFirsts.occurredAt,
        })
        .from(dailyFirsts)
        .orderBy(desc(dailyFirsts.day))
        .limit(DAY_COUNT),
      db.execute<{
        day: string
        display_name: string | null
        value: string
        occurred_at: string
      }>(sql`
        select day, display_name, value, occurred_at
        from (
          select
            to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD') as day,
            display_name,
            value,
            occurred_at,
            row_number() over (
              partition by to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD')
              order by value asc
            ) as rn
          from onchain_results
          where board = 'daily_time'
        ) ranked
        where rn = 1
        order by day desc
        limit ${DAY_COUNT}
      `),
    ])

    const firstItems: TickerItem[] = firstsRows.map((r) => ({
      kind: 'first',
      day: r.day,
      cleanName: r.cleanName,
      occurredAt: r.occurredAt.toISOString(),
    }))

    // display_name is already sanitized at ingest (lib/game/indexerSeam.ts) — a missing
    // name (never sanitized, e.g. an old row) falls back the same way cleanDisplayName
    // would for an empty name, so the ticker never renders a blank racer.
    const fastestItems: TickerItem[] = fastestRows.rows
      .filter((r) => r.display_name)
      .map((r) => ({
        kind: 'fastest',
        day: r.day,
        cleanName: r.display_name as string,
        occurredAt: new Date(r.occurred_at).toISOString(),
        value: String(r.value),
      }))

    const items = [...firstItems, ...fastestItems].sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1 // most recent day first
      if (a.kind === b.kind) return 0
      return a.kind === 'first' ? -1 : 1 // 'first' before 'fastest' within the same day
    })

    return res.status(200).json({ items })
  } catch {
    return res.status(500).json({ error: 'ticker_load_failed' })
  }
}
