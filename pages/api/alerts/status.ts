import type { NextApiRequest, NextApiResponse } from 'next'

import { storageReady, type Sql } from '@/lib/userAlerts/store'
import { neonSql, processEnv, telegramOn, type Env } from '@/pages/api/_lib/userAlerts'

// GET /api/alerts/status — what the "Alert me at" control may offer right now.
//   storage   DATABASE_URL is set AND the alert tables answer a zero-row read
//   telegram  bot token + username + webhook secret are all set
//   rss       the feed can be served (= storage)
// Booleans only; no env value is ever echoed. The same for every caller, so it is
// cached briefly at the edge and in memory (the table probe is not free).

export type AlertsStatus = { storage: boolean; telegram: boolean; rss: boolean }

export type StatusDeps = { env: Env; sql: () => Sql; nowMs?: () => number }

const MEMO_MS = 30_000

export const createStatusHandler = (deps: StatusDeps) => {
  let memo: { at: number; body: AlertsStatus } | null = null
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).json({ error: 'GET only' })
    }
    const now = (deps.nowMs ?? Date.now)()
    if (!memo || now - memo.at >= MEMO_MS) {
      const storage = !!deps.env('DATABASE_URL') && (await storageReady(deps.sql()))
      memo = { at: now, body: { storage, telegram: storage && telegramOn(deps.env).on, rss: storage } }
    }
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60')
    return res.status(200).json(memo.body)
  }
}

export default createStatusHandler({ env: processEnv, sql: neonSql(processEnv) })
