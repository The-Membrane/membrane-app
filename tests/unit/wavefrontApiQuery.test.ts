/**
 * /api/wavefront/stream with a database, the query mocked (no network): a missing table is a
 * 503 with a plain message; rows come back as schema-v1 records with a `next` cursor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('@/pages/api/_lib/wavefrontEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/pages/api/_lib/wavefrontEvents')>()),
  fetchWavefrontEvents: fetchMock,
}))

import handler from '@/pages/api/wavefront/stream'
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
    expect(res.body.records.map((r: any) => r.seq)).toEqual([11, 12, 13])
    expect(res.body.next).toBe(13)

    fetchMock.mockResolvedValue(rows.slice(0, 2))
    const res2 = mockRes()
    await handler({ method: 'GET', query: { after: '10', limit: '99999' } } as any, res2)
    expect(fetchMock).toHaveBeenLastCalledWith(10, 5000)
    expect(res2.body.next).toBeNull()
  })

  it('rejects a bad cursor', async () => {
    const res = mockRes()
    await handler({ method: 'GET', query: { after: '-1' } } as any, res)
    expect(res.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
