/**
 * Live source for the wavefront: pages of stream records (the schema lib/wavefront/stream.ts
 * reads) from /api/wavefront/stream, folded into a WavefrontTimeline. Pure enough to test
 * without a network: the fetcher is injected.
 */

import { STREAM_SCHEMA, TICK_EVERY_MINUTES, type StreamRecord } from '@/lib/wavefront/stream'

import type { WavefrontTimeline } from './model'

/** No successful answer from the endpoint for this long: stale. */
export const LIVE_NO_ANSWER_STALE_S = 180
/** The stream writes a tick every TICK_EVERY_MINUTES minutes of its one-minute grid. */
export const TICK_INTERVAL_S = TICK_EVERY_MINUTES * 60
/** A tick is overdue — the engine has stopped — this long after the previous one. */
export const TICK_OVERDUE_S = TICK_INTERVAL_S + 180

/**
 * Live data is stale (headline withheld, panels hatched, never "Live") when the endpoint has
 * not answered for LIVE_NO_ANSWER_STALE_S, or the newest tick is overdue (TICK_OVERDUE_S).
 * Between two on-time ticks the data is fresh: ticks are 10 minutes apart by design.
 */
export function liveIsStale(nowS: number, lastAnswerS: number | null, lastTickS: number | null) {
  if (lastAnswerS === null || nowS - lastAnswerS > LIVE_NO_ANSWER_STALE_S) return true
  return lastTickS === null || nowS - lastTickS > TICK_OVERDUE_S
}

export const LIVE_ENDPOINT = '/api/wavefront/stream'
export const LIVE_POLL_MS = 30_000
export const LIVE_PAGE_SIZE = 2000
/** A first load pages through at most this many pages; the next poll continues. */
export const LIVE_MAX_PAGES = 50

/** The endpoint's 200 body. `next` is the seq to ask after for more, or null when caught up. */
export interface StreamPage {
  schema: number
  after: number
  records: StreamRecord[]
  next: number | null
}

export type PageFetcher = (after: number) => Promise<StreamPage>

/** Thrown when the endpoint does not answer 200 (503 while the live table does not exist). */
export class LiveUnavailableError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const httpPageFetcher =
  (endpoint = LIVE_ENDPOINT, limit = LIVE_PAGE_SIZE): PageFetcher =>
  async (after) => {
    const res = await fetch(`${endpoint}?after=${after}&limit=${limit}`, { cache: 'no-store' })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new LiveUnavailableError(res.status, text || `${res.status} ${res.statusText}`)
    }
    const body = (await res.json()) as StreamPage
    if (!body || !Array.isArray(body.records)) {
      throw new LiveUnavailableError(502, 'live stream: malformed page')
    }
    if (body.schema !== STREAM_SCHEMA) {
      throw new LiveUnavailableError(
        502,
        `live stream: schema ${body.schema}, this page reads ${STREAM_SCHEMA}`,
      )
    }
    return body
  }

/**
 * Fetch every record after the timeline's last seq and append it. Idempotent: a page that
 * repeats records already held adds nothing (the timeline merges by seq). Returns the number
 * of records added.
 */
export async function pollInto(
  timeline: WavefrontTimeline,
  fetchPage: PageFetcher,
  maxPages = LIVE_MAX_PAGES,
): Promise<number> {
  let added = 0
  for (let page = 0; page < maxPages; page++) {
    const before = timeline.lastSeq
    const p = await fetchPage(before)
    added += timeline.append(p.records)
    if (p.next === null || p.records.length === 0 || timeline.lastSeq === before) break
  }
  return added
}
