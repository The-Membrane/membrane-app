import type { NextApiRequest, NextApiResponse } from 'next'

import {
  fetchWavefrontEvents,
  isMissingTable,
  rowToRecord,
  WAVEFRONT_PAGE_DEFAULT,
  WAVEFRONT_PAGE_MAX,
} from '@/pages/api/_lib/wavefrontEvents'
import type { StreamRecord } from '@/lib/wavefront/stream'

// PUBLIC, read-only. The live wavefront stream: schema-v1 records with seq > `after`, oldest
// first, at most `limit` (default 2,000, max 5,000). `next` is the seq to ask after for the
// following page, or null when caught up. The page polls it every 30 s
// (components/Wavefront/live.ts) and folds the records with the stream reducer.
//
// 503 with a plain message while there is no database or no wavefront_events table — the
// live engine's table is pending owner approval — so the page shows the Oct 10 replay.

const intParam = (v: string | string[] | undefined): number | null => {
  const s = Array.isArray(v) ? v[0] : v
  if (s === undefined || s === '') return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : NaN
}

function unavailable(res: NextApiResponse, message: string) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  return res.status(503).send(message)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    return res.status(405).send('GET only.')
  }
  if (!process.env.DATABASE_URL) {
    return unavailable(res, 'Live wavefront unavailable: DATABASE_URL is not set.')
  }

  const after = intParam(req.query.after) ?? 0
  const limitIn = intParam(req.query.limit) ?? WAVEFRONT_PAGE_DEFAULT
  if (Number.isNaN(after) || after < 0 || Number.isNaN(limitIn) || limitIn < 1) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    return res.status(400).send('after must be an integer >= 0 and limit an integer >= 1.')
  }
  const limit = Math.min(limitIn, WAVEFRONT_PAGE_MAX)

  let rows
  try {
    rows = await fetchWavefrontEvents(after, limit)
  } catch (e) {
    if (isMissingTable(e)) {
      return unavailable(
        res,
        'Live wavefront unavailable: the wavefront_events table does not exist yet.',
      )
    }
    console.error('[api/wavefront/stream] query failed', e)
    return unavailable(res, 'Live wavefront unavailable: the event store did not answer.')
  }

  const records = rows.map(rowToRecord).filter((r): r is StreamRecord => r !== null)
  const next = rows.length === limit ? Number(rows[rows.length - 1].seq) : null
  return res.status(200).json({ schema: 1, after, records, next })
}
