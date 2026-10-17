import { sql } from 'drizzle-orm'

import type { StreamRecord } from '@/lib/wavefront/stream'

/**
 * The live wavefront's event store (server-only): Postgres table
 *
 *   wavefront_events(stream text, seq bigint, ts timestamptz, kind text, pid text, body jsonb)
 *
 * (primary key (stream, seq); the live engine's db/migrations-pending/2026-10-14_wavefront_live.sql),
 * one row per stream record (lib/wavefront/stream.ts, the schema STREAM_SCHEMA names), written
 * by the live engine in seq order (a single writer, so seq commits in order and `seq > after`
 * paging never skips a row). `body` is the record itself; `seq` and `kind` come from their
 * columns, `pid` from the body or its column, `ts` (unix seconds) from the body or the column.
 *
 * The table does not exist yet (the live engine's DDL is pending owner approval); the route
 * answers 503 until it does. Lives outside pages/ so it is not itself an API route.
 */

/** The stream the page reads: the engine's `--stream` id (default `main`). */
export function wavefrontStreamId(env: Record<string, string | undefined> = process.env): string {
  const id = env.WAVEFRONT_STREAM?.trim()
  return id ? id : 'main'
}

export const WAVEFRONT_PAGE_DEFAULT = 2000
export const WAVEFRONT_PAGE_MAX = 5000

export interface WavefrontEventRow {
  seq: string | number
  ts: string | Date | null
  kind: string
  pid: string | null
  body: unknown
}

const KINDS = new Set(['open', 'real', 'mem', 'tick'])

/** A row as a stream record, or null when it is not one (unknown kind, unparseable body…). */
export function rowToRecord(row: WavefrontEventRow): StreamRecord | null {
  if (!KINDS.has(row.kind)) return null
  let body: unknown = row.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const seq = Number(row.seq)
  if (!Number.isSafeInteger(seq) || seq <= 0) return null
  let ts = typeof b.ts === 'number' ? b.ts : NaN
  if (!Number.isFinite(ts) && row.ts != null) ts = Math.floor(new Date(row.ts).getTime() / 1000)
  if (!Number.isFinite(ts)) return null
  const rec: Record<string, unknown> = { ...b, kind: row.kind, seq, ts }
  if (row.kind !== 'tick' && typeof rec.pid !== 'string') {
    if (!row.pid) return null
    rec.pid = row.pid
  }
  return rec as unknown as StreamRecord
}

/** Postgres "undefined_table" (42P01), however the driver wraps it. */
export function isMissingTable(e: unknown): boolean {
  for (let cur: any = e, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    if (cur.code === '42P01') return true
    if (
      typeof cur.message === 'string' &&
      /relation .*wavefront_events.* does not exist/i.test(cur.message)
    )
      return true
  }
  return false
}

/**
 * One stream's rows with seq > after, oldest first, at most `limit`. Server-only (the db client
 * is). seq is per stream, so the filter keeps a second stream (a test run) out of the page.
 */
export async function fetchWavefrontEvents(
  after: number,
  limit: number,
  stream: string = wavefrontStreamId(),
): Promise<WavefrontEventRow[]> {
  const { db } = await import('@/db')
  const result = await db.execute(sql`
    SELECT seq, ts, kind, pid, body
    FROM wavefront_events
    WHERE stream = ${stream} AND seq > ${after}
    ORDER BY seq ASC
    LIMIT ${limit}`)
  return result.rows as unknown as WavefrontEventRow[]
}
