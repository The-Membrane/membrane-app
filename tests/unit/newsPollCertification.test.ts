import { describe, expect, it } from 'vitest'

import { certifyNewsPoll } from '@/lib/carry/newsPollCertification'
import { rssUrl } from '@/scripts/fetch-venue-news.mjs'
import { sourceIdentity } from '@/scripts/lib/newsPollLedger.mjs'

const NOW = Date.parse('2026-10-05T00:00:00.000Z')
const SOURCE = 'aave-v3-usdc'
const QUERY = 'Aave V3 USDC'
const empty = {
  venue: SOURCE,
  receiptVersion: 3,
  status: 'success',
  coverageStatus: 'observed_below_cap',
  source: sourceIdentity(QUERY, rssUrl(QUERY)),
  startedAtUtc: '2026-10-04T23:29:59.000Z',
  endedAtUtc: '2026-10-04T23:30:00.000Z',
  feedItemCount: 0,
  parsedItemCount: 0,
  parsedItemIdentitySha256s: [],
}

describe('protocol headline poll certification', () => {
  it('never presents an empty feed as evidence of current quiet', () => {
    expect(certifyNewsPoll(empty, SOURCE, QUERY, NOW)).toEqual({
      status: 'unavailable',
      identities: [],
    })
  })

  it('keeps missing, failed, incomplete, stale, and query-drifted polls unavailable', () => {
    const unavailable = { status: 'unavailable', identities: [] }
    expect(certifyNewsPoll(undefined, SOURCE, QUERY, NOW)).toEqual(unavailable)
    for (const receipt of [
      { ...empty, status: 'fetch_error' },
      { ...empty, coverageStatus: 'incomplete_items' },
      { ...empty, feedItemCount: 1 },
      { ...empty, endedAtUtc: '2026-10-04T22:29:59.999Z' },
      { ...empty, endedAtUtc: '2026-10-05T00:05:00.001Z' },
      { ...empty, source: sourceIdentity('Aave V3 USDe', rssUrl('Aave V3 USDe')) },
      { ...empty, venue: 'aave-v3-usde' },
      { ...empty, receiptVersion: 2 },
      { ...empty, receiptVersion: undefined },
    ]) {
      expect(certifyNewsPoll(receipt, SOURCE, QUERY, NOW)).toEqual(unavailable)
    }
  })

  it('allows a fresh complete poll to surface an identity-bound headline', () => {
    const identity = 'a'.repeat(64)
    expect(
      certifyNewsPoll(
        {
          ...empty,
          feedItemCount: 1,
          parsedItemCount: 1,
          parsedItemIdentitySha256s: [identity],
        },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual({
      status: 'items',
      coverage: 'observed_items',
      observedAt: empty.startedAtUtc,
      identities: [identity],
    })
  })

  it('keeps a nonempty v2 receipt unavailable because its item identity omits source', () => {
    expect(
      certifyNewsPoll(
        {
          ...empty,
          receiptVersion: 2,
          feedItemCount: 1,
          parsedItemCount: 1,
          parsedItemIdentitySha256s: ['a'.repeat(64)],
        },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual({ status: 'unavailable', identities: [] })
  })

  it('surfaces a capped nonempty poll as a bounded latest-items set', () => {
    const identities = Array.from({ length: 25 }, (_, index) =>
      index.toString(16).padStart(64, '0'),
    )
    expect(
      certifyNewsPoll(
        {
          ...empty,
          coverageStatus: 'at_or_over_cap',
          feedItemCount: 67,
          parsedItemCount: 25,
          parsedItemIdentitySha256s: identities,
        },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual({
      status: 'items',
      coverage: 'latest_items_only',
      observedAt: empty.startedAtUtc,
      identities,
    })
  })

  it('does not turn an empty or internally inconsistent capped poll into quiet evidence', () => {
    const unavailable = { status: 'unavailable', identities: [] }
    expect(
      certifyNewsPoll(
        { ...empty, coverageStatus: 'at_or_over_cap', feedItemCount: 25 },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual(unavailable)
    expect(
      certifyNewsPoll(
        {
          ...empty,
          coverageStatus: 'at_or_over_cap',
          feedItemCount: 67,
          parsedItemCount: 24,
          parsedItemIdentitySha256s: Array.from({ length: 24 }, (_, index) =>
            index.toString(16).padStart(64, '0'),
          ),
        },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual(unavailable)
  })

  it('expires a previously mirrored headline after one native cadence plus slack', () => {
    const item = {
      ...empty,
      feedItemCount: 1,
      parsedItemCount: 1,
      parsedItemIdentitySha256s: ['a'.repeat(64)],
    }
    expect(certifyNewsPoll(item, SOURCE, QUERY, NOW).status).toBe('items')
    expect(
      certifyNewsPoll({ ...item, endedAtUtc: '2026-10-04T22:29:59.999Z' }, SOURCE, QUERY, NOW),
    ).toEqual({ status: 'unavailable', identities: [] })
  })

  it('rejects a stale displayed start clock and a delayed poll write', () => {
    const item = {
      ...empty,
      feedItemCount: 1,
      parsedItemCount: 1,
      parsedItemIdentitySha256s: ['a'.repeat(64)],
    }
    const unavailable = { status: 'unavailable', identities: [] }

    expect(
      certifyNewsPoll(
        {
          ...item,
          startedAtUtc: '2026-10-04T22:29:59.999Z',
          endedAtUtc: '2026-10-04T22:30:00.000Z',
        },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual(unavailable)
    expect(
      certifyNewsPoll(
        {
          ...item,
          startedAtUtc: '2026-10-04T23:19:59.999Z',
          endedAtUtc: '2026-10-04T23:30:00.000Z',
        },
        SOURCE,
        QUERY,
        NOW,
      ),
    ).toEqual(unavailable)
    expect(
      certifyNewsPoll(
        {
          ...item,
          startedAtUtc: '2026-10-04T23:20:00.000Z',
          endedAtUtc: '2026-10-04T23:30:00.000Z',
        },
        SOURCE,
        QUERY,
        NOW,
      ).status,
    ).toBe('items')
  })
})
