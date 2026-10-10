import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import handler from '@/pages/api/venues/news'
import { readLocalNews, selectLocalNews } from '@/scripts/lib/venueNewsLocalStore.mjs'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))
vi.mock('@/scripts/lib/venueNewsLocalStore.mjs', () => ({
  readLocalNews: vi.fn(),
  selectLocalNews: vi.fn(),
}))

const ITEM = {
  venue: 'sGHO',
  title: 'Verbatim headline',
  source: 'Publisher',
  url: 'https://example.com/headline',
  publishedAt: '2026-09-30T20:00:00.000Z',
  fetchedAt: '2026-09-30T21:00:00.000Z',
}

async function request(
  remoteAddress = '127.0.0.1',
  query: Record<string, unknown> = {},
  method = 'GET',
) {
  const headers: Record<string, string> = {}
  let code = 0
  let body: unknown
  const res = {
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value
    }),
    status: vi.fn((status: number) => {
      code = status
      return res
    }),
    json: vi.fn((value: unknown) => {
      body = value
      return res
    }),
  }
  await handler({ method, query, socket: { remoteAddress } } as never, res as never)
  return { code, body, headers }
}

describe('GET /api/venues/news local fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T22:00:00.000Z'))
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(db.execute).mockReset()
    vi.mocked(readLocalNews)
      .mockReset()
      .mockReturnValue({
        version: 1,
        updatedAt: '2026-09-30T21:00:00.000Z',
        items: [ITEM],
      })
    vi.mocked(selectLocalNews).mockReset().mockReturnValue([ITEM])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('serves exact locally recorded rows and freshness only after DB failure on loopback', async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error('secret DB URL'))
    const result = await request('127.0.0.1', { venue: 'sGHO' })
    expect(result.code).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.body).toEqual({
      items: [ITEM],
      provenance: {
        storage: 'local_mac_recorder',
        feed: 'google_news_rss_search',
        snapshotUpdatedAt: '2026-09-30T21:00:00.000Z',
        maxAgeSeconds: 10_800,
        coverageStatus: 'unavailable',
        pollReceiptBinding: 'not_verified',
      },
    })
    expect(selectLocalNews).toHaveBeenCalledWith(expect.anything(), {
      venue: 'sGHO',
      perVenue: 15,
      fetchedAfter: '2026-09-30T19:00:00.000Z',
      fetchedBefore: '2026-09-30T22:05:00.000Z',
    })
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })

  it('uses database data when available and never opens the local snapshot', async () => {
    vi.mocked(db.execute).mockResolvedValue({
      rows: [
        {
          venue: ITEM.venue,
          title: ITEM.title,
          source: ITEM.source,
          url: ITEM.url,
          published_at: ITEM.publishedAt,
          fetched_at: ITEM.fetchedAt,
        },
      ],
    } as never)
    const result = await request()
    expect(result.code).toBe(200)
    expect(readLocalNews).not.toHaveBeenCalled()
    expect(result.body).toMatchObject({
      items: [ITEM],
      provenance: { storage: 'database', feed: 'google_news_rss_search' },
    })
  })

  it('fails closed outside development loopback and when local data is absent', async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error('DB outage'))
    expect((await request('192.0.2.1')).code).toBe(503)
    expect(readLocalNews).not.toHaveBeenCalled()
    vi.stubEnv('NODE_ENV', 'production')
    expect((await request()).code).toBe(503)
    expect(readLocalNews).not.toHaveBeenCalled()
    vi.stubEnv('NODE_ENV', 'development')
    vi.mocked(readLocalNews).mockReturnValue({ version: 1, updatedAt: null, items: [] })
    expect((await request()).code).toBe(503)
    expect(selectLocalNews).not.toHaveBeenCalled()
  })

  it('rejects old snapshots and old headlines even if the snapshot was just updated', async () => {
    vi.mocked(db.execute).mockRejectedValue(new Error('DB outage'))
    vi.mocked(readLocalNews).mockReturnValueOnce({
      version: 1,
      updatedAt: '2026-09-30T18:59:59.999Z',
      items: [ITEM],
    })
    expect((await request()).code).toBe(503)
    expect(selectLocalNews).not.toHaveBeenCalled()

    vi.mocked(readLocalNews).mockReturnValueOnce({
      version: 1,
      updatedAt: '2026-09-30T21:59:00.000Z',
      items: [{ ...ITEM, fetchedAt: '2026-09-30T18:00:00.000Z' }],
    })
    vi.mocked(selectLocalNews).mockReturnValueOnce([
      { ...ITEM, fetchedAt: '2026-09-30T18:00:00.000Z' },
    ])
    expect((await request()).code).toBe(503)
  })

  it('rejects method and oversized venue before accessing either source', async () => {
    expect((await request('127.0.0.1', {}, 'POST')).code).toBe(405)
    expect((await request('127.0.0.1', { venue: 'x'.repeat(129) })).code).toBe(400)
    expect(db.execute).not.toHaveBeenCalled()
  })
})
