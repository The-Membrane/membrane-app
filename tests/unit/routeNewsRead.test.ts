import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  readLocalNews: vi.fn(),
  verifyPolls: vi.fn(),
}))

vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
vi.mock('@/scripts/lib/venueNewsLocalStore.mjs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readLocalNews: mocks.readLocalNews,
}))
vi.mock('@/scripts/lib/newsPollLedger.mjs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyPolls: mocks.verifyPolls,
  verifyPollReceipt: (receipt: unknown) => receipt,
}))

import { readNews } from '@/pages/api/carry/route-context'
import { rssUrl } from '@/scripts/fetch-venue-news.mjs'
import { parsedItemIdentity, sourceIdentity } from '@/scripts/lib/newsPollLedger.mjs'

const NOW = Date.parse('2026-10-05T00:00:00.000Z')
const SOURCE = 'aave-v3-usdc'
const QUERY = 'Aave V3 USDC'
const headline = {
  venue: SOURCE,
  title: 'Aave headline',
  source: 'Publisher',
  url: 'https://news.example.com/aave',
  publishedAt: '2026-10-04T23:20:00.000Z',
  fetchedAt: '2026-10-04T23:10:00.000Z',
}
const receipt = {
  sequence: 1,
  venue: SOURCE,
  receiptVersion: 3,
  status: 'success',
  coverageStatus: 'observed_below_cap',
  source: sourceIdentity(QUERY, rssUrl(QUERY)),
  startedAtUtc: '2026-10-04T23:29:59.000Z',
  endedAtUtc: '2026-10-04T23:30:01.000Z',
  feedItemCount: 1,
  parsedItemCount: 1,
  parsedItemIdentitySha256s: [parsedItemIdentity(headline)],
  sha256: 'a'.repeat(64),
}

const localRequest = { socket: { remoteAddress: '127.0.0.1' } } as never
const productionRequest = { socket: { remoteAddress: '203.0.113.2' } } as never

describe('route news receipt reads', () => {
  beforeEach(() => {
    mocks.execute.mockReset()
    mocks.readLocalNews.mockReset()
    mocks.verifyPolls.mockReset()
    mocks.verifyPolls.mockReturnValue({ receipts: [] })
  })

  it('serves a verified local receipt and snapshot without querying the database', async () => {
    const previousMode = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      mocks.verifyPolls.mockReturnValue({ receipts: [receipt] })
      mocks.readLocalNews.mockReturnValue({
        version: 1,
        updatedAt: '2026-10-04T23:30:00.000Z',
        items: [headline],
      })
      expect(await readNews(SOURCE, QUERY, NOW, localRequest)).toEqual({
        status: 'available',
        coverage: 'observed_items',
        observedItemCount: 1,
        observedAt: receipt.startedAtUtc,
        items: [headline],
      })
      expect(mocks.execute).not.toHaveBeenCalled()
      expect(mocks.readLocalNews).toHaveBeenCalledOnce()
    } finally {
      process.env.NODE_ENV = previousMode
    }
  })

  it('uses an exact local snapshot after the DB receipt mirror succeeds', async () => {
    const previousMode = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      mocks.execute.mockResolvedValueOnce({
        rows: [{ sequence: 1, receipt_text: JSON.stringify(receipt) }],
      })
      mocks.readLocalNews.mockReturnValue({
        version: 1,
        updatedAt: '2026-10-04T23:30:00.000Z',
        items: [headline],
      })
      expect(await readNews(SOURCE, QUERY, NOW, localRequest)).toEqual({
        status: 'available',
        coverage: 'observed_items',
        observedItemCount: 1,
        observedAt: receipt.startedAtUtc,
        items: [headline],
      })
      expect(mocks.execute).toHaveBeenCalledOnce()
      expect(mocks.readLocalNews).toHaveBeenCalledOnce()
    } finally {
      process.env.NODE_ENV = previousMode
    }
  })

  it('does not present a previously mirrored empty poll as current quiet', async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          sequence: 1,
          receipt_text: JSON.stringify({
            ...receipt,
            feedItemCount: 0,
            parsedItemCount: 0,
            parsedItemIdentitySha256s: [],
          }),
        },
      ],
    })
    expect(await readNews(SOURCE, QUERY, NOW, productionRequest)).toEqual({
      status: 'unavailable',
      reason: 'source_unavailable',
    })
    expect(mocks.execute).toHaveBeenCalledOnce()
  })

  it('serves every identity-bound item from a capped poll with bounded coverage', async () => {
    const previousMode = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const items = Array.from({ length: 25 }, (_, index) => ({
        ...headline,
        title: `Aave headline ${index}`,
        url: `https://news.example.com/aave/${index}`,
      }))
      const capped = {
        ...receipt,
        coverageStatus: 'at_or_over_cap',
        feedItemCount: 67,
        parsedItemCount: items.length,
        parsedItemIdentitySha256s: items.map(parsedItemIdentity),
      }
      mocks.verifyPolls.mockReturnValue({ receipts: [capped] })
      mocks.readLocalNews.mockReturnValue({
        version: 1,
        updatedAt: '2026-10-04T23:30:00.000Z',
        items,
      })
      const result = await readNews(SOURCE, QUERY, NOW, localRequest)
      expect(result).toMatchObject({
        status: 'available',
        coverage: 'latest_items_only',
        observedItemCount: 25,
        observedAt: receipt.startedAtUtc,
      })
      expect(result.status).toBe('available')
      if (result.status === 'available') {
        expect(result.items).toHaveLength(25)
        expect(result.items.map((item) => item.url)).toEqual(items.map((item) => item.url))
      }
      expect(mocks.execute).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = previousMode
    }
  })

  it('fails closed when a capped receipt cannot be joined to its full saved item set', async () => {
    const previousMode = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const items = Array.from({ length: 25 }, (_, index) => ({
        ...headline,
        title: `Aave headline ${index}`,
        url: `https://news.example.com/aave/${index}`,
      }))
      mocks.verifyPolls.mockReturnValue({
        receipts: [
          {
            ...receipt,
            coverageStatus: 'at_or_over_cap',
            feedItemCount: 67,
            parsedItemCount: 25,
            parsedItemIdentitySha256s: items.map(parsedItemIdentity),
          },
        ],
      })
      mocks.readLocalNews.mockReturnValue({
        version: 1,
        updatedAt: '2026-10-04T23:30:00.000Z',
        items: items.slice(0, 24),
      })
      expect(await readNews(SOURCE, QUERY, NOW, localRequest)).toEqual({
        status: 'unavailable',
        reason: 'source_unavailable',
      })
    } finally {
      process.env.NODE_ENV = previousMode
    }
  })

  it('rejects source text that does not match the versioned item identity', async () => {
    const previousMode = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      mocks.verifyPolls.mockReturnValue({ receipts: [receipt] })
      mocks.readLocalNews.mockReturnValue({
        version: 1,
        updatedAt: '2026-10-04T23:30:00.000Z',
        items: [{ ...headline, source: 'Changed publisher' }],
      })
      expect(await readNews(SOURCE, QUERY, NOW, localRequest)).toEqual({
        status: 'unavailable',
        reason: 'source_unavailable',
      })
    } finally {
      process.env.NODE_ENV = previousMode
    }
  })

  it('expires a mirrored headline if the native cadence or receipt mirroring stops', async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          sequence: 1,
          receipt_text: JSON.stringify({ ...receipt, endedAtUtc: '2026-10-04T22:29:59.999Z' }),
        },
      ],
    })
    expect(await readNews(SOURCE, QUERY, NOW, productionRequest)).toEqual({
      status: 'unavailable',
      reason: 'source_unavailable',
    })
    expect(mocks.execute).toHaveBeenCalledOnce()
  })
})
