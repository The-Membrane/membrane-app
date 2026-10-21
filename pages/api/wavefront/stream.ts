import type { NextApiRequest, NextApiResponse } from 'next'

import {
  fetchWavefrontEvents,
  isMissingTable,
  rowToRecord,
  WAVEFRONT_PAGE_DEFAULT,
  WAVEFRONT_PAGE_MAX,
} from '@/lib/wavefront/server/events'
import { STREAM_SCHEMA, type StreamRecord } from '@/lib/wavefront/stream'

// PUBLIC, read-only. The live wavefront stream: records with seq > `after`, oldest first, at
// most `limit` (default 2,000, max 5,000), as `{ schema, after, records, next }`. `next` is the
// seq to ask after for the following page, or null when caught up. The page polls it every
// 30 s (components/Wavefront/live.ts) and folds the records with the stream reducer.
//
// 503 with a plain message while there is no database or no wavefront_events table — the
// live engine's table is pending owner approval — so the page shows the Oct 10 replay.
// 502 when a row is not a stream record (the page must not fold around a hole).
//
// CACHING. A full page (`next` set) can never change — seq is append-only with one writer —
// so it is cacheable for a year at the edge; only the tail page (`next` null) is no-store.
//
// BEFORE GO-LIVE: a client that opens the page pages through the WHOLE history from seq 0
// (the Oct 10-11 replay alone is ~18,700 records). A server-side snapshot endpoint — the
// reducer's state plus the per-position view at a recent seq — is needed so a new client
// loads O(positions), not O(records), and then polls only the tail. Not built yet.

const intParam = (v: string | string[] | undefined): number | null => {
  const s = Array.isArray(v) ? v[0] : v
  if (s === undefined || s === '') return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : NaN
}

function plain(res: NextApiResponse, status: number, message: string) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  return res.status(status).send(message)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return plain(res, 405, 'GET only.')
  }
  if (!process.env.DATABASE_URL) {
    return plain(res, 503, 'Live wavefront unavailable: DATABASE_URL is not set.')
  }

  const after = intParam(req.query.after) ?? 0
  const limitIn = intParam(req.query.limit) ?? WAVEFRONT_PAGE_DEFAULT
  if (Number.isNaN(after) || after < 0 || Number.isNaN(limitIn) || limitIn < 1) {
    return plain(res, 400, 'after must be an integer >= 0 and limit an integer >= 1.')
  }
  const limit = Math.min(limitIn, WAVEFRONT_PAGE_MAX)

  let records: StreamRecord[]
  let next: number | null
  try {
    const rows = await fetchWavefrontEvents(after, limit)
    records = []
    for (const row of rows) {
      const rec = rowToRecord(row)
      if (!rec) {
        return plain(
          res,
          502,
          `Live wavefront unavailable: event ${row.seq} is not a stream record.`,
        )
      }
      records.push(rec)
    }
    next = rows.length === limit ? Number(rows[rows.length - 1].seq) : null
  } catch (e) {
    if (isMissingTable(e)) {
      return plain(
        res,
        503,
        'Live wavefront unavailable: the wavefront_events table does not exist yet.',
      )
    }
    console.error('[api/wavefront/stream] query failed', e)
    return plain(res, 503, 'Live wavefront unavailable: the event store did not answer.')
  }

  res.setHeader(
    'Cache-Control',
    next === null ? 'no-store' : 'public, s-maxage=31536000, immutable',
  )
  return res.status(200).json({ schema: STREAM_SCHEMA, after, records, next })
}
