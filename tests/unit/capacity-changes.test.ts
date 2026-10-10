import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { observationStatus, verifyFeed } from '../../pages/api/venues/capacity-changes'

const now = Date.parse('2026-09-30T06:00:00.000Z')
const recent = new Date(now - 60 * 60 * 1000).toISOString()
const stale = new Date(now - 45 * 60 * 60 * 1000).toISOString()

const sealed = (coveredThroughAt?: string) => {
  const payload = {
    study: 'morpho-v2-cap-public-feed-v1',
    source: 'verified segments',
    scope: 'allocation cap activity',
    checkedAt: recent,
    coveredThroughBlock: 26_074_965,
    ...(coveredThroughAt === undefined ? {} : { coveredThroughAt }),
    items: [],
    limitation: 'not exit capacity',
  }
  return {
    ...payload,
    sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  } as Parameters<typeof verifyFeed>[0]
}

describe('Morpho cap feed freshness', () => {
  it('pauses a newly checked export whose covered chain block is old', () => {
    const feed = verifyFeed(sealed(stale))
    expect(observationStatus(feed.checkedAt, feed.coveredThroughAt, now)).toBe('paused')
  })

  it('fails closed when covered-through clock is missing or invalid, even if resealed', () => {
    expect(() => verifyFeed(sealed())).toThrow('Invalid capacity-change feed')
    expect(() => verifyFeed(sealed('not-a-clock'))).toThrow('Invalid capacity-change feed')
    expect(observationStatus(recent, '', now)).toBe('paused')
  })

  it('is recent only while both local observation and chain coverage are recent', () => {
    const feed = verifyFeed(sealed(recent))
    expect(observationStatus(feed.checkedAt, feed.coveredThroughAt, now)).toBe('recent')
    expect(observationStatus(stale, recent, now)).toBe('paused')
    expect(observationStatus(recent, new Date(now + 1000).toISOString(), now)).toBe('paused')
  })
})
