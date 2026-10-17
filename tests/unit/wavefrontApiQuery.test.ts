/**
 * /api/wavefront/stream with a database, the query mocked (no network): a missing table is a
 * 503 with a plain message; rows come back as stream records (`schema` = STREAM_SCHEMA) with a
 * `next` cursor; a row that is not a record is a 502; full pages are cacheable, the tail is not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('@/lib/wavefront/server/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/wavefront/server/events')>()),
  fetchWavefrontEvents: fetchMock,
}))

import handler from '@/pages/api/wavefront/stream'
import { STREAM_SCHEMA } from '@/lib/wavefront/stream'
import { mockRes } from './fixtures/mockApiRes'

describe('GET /api/wavefront/stream with a database', () => {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://user:pass@localhost/none'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
  })
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('answers 503 while the wavefront_events table does not exist', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('relation does not exist'), { code: '42P01' }),
    )
    const res = mockRes()
    await handler({ method: 'GET', query: { after: '0' } } as any, res)
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.body).toBe(
      'Live wavefront unavailable: the wavefront_events table does not exist yet.',
    )
  })

  it('returns records after `after`, bounded, with the next cursor', async () => {
    const rows = [1, 2, 3].map((seq) => ({
      seq: String(seq + 10),
      ts: null,
      kind: 'tick',
      pid: null,
      body: { ts: 1760054400 + seq * 600, minute: seq * 10 - 1 },
    }))
    fetchMock.mockResolvedValue(rows)
    const res = mockRes()
    await handler({ method: 'GET', query: { after: '10', limit: '3' } } as any, res)
    expect(fetchMock).toHaveBeenCalledWith(10, 3)
    expect(res.statusCode).toBe(200)
    expect(res.body.schema).toBe(STREAM_SCHEMA)
    expect(res.body.records.map((r: any) => r.seq)).toEqual([11, 12, 13])
    expect(res.body.next).toBe(13)
    // a full page never changes (append-only, one writer): cacheable at the edge
    expect(res.headers['cache-control']).toBe('public, s-maxage=31536000, immutable')

    fetchMock.mockResolvedValue(rows.slice(0, 2))
    const res2 = mockRes()
    await handler({ method: 'GET', query: { after: '10', limit: '99999' } } as any, res2)
    expect(fetchMock).toHaveBeenLastCalledWith(10, 5000)
    expect(res2.body.next).toBeNull()
    // the tail page is not cached
    expect(res2.headers['cache-control']).toBe('no-store')
  })

  it('a row that is not a stream record is a 502, not a crash', async () => {
    fetchMock.mockResolvedValue([
      { seq: '21', ts: null, kind: 'tick', pid: null, body: '{"ts": 1760054400' },
    ])
    const res = mockRes()
    await handler({ method: 'GET', query: { after: '20' } } as any, res)
    expect(res.statusCode).toBe(502)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.body).toBe('Live wavefront unavailable: event 21 is not a stream record.')
  })

  it('rejects a bad cursor', async () => {
    const res = mockRes()
    await handler({ method: 'GET', query: { after: '-1' } } as any, res)
    expect(res.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
