import { describe, expect, it } from 'vitest'

import { describeRouteReading, ROUTE_STALE_AFTER_MS } from '@/lib/carry/liveRouteFreshness'

const NOW = Date.parse('2026-09-26T18:00:00.000Z')

describe('daily route reading age', () => {
  it('keeps a daily reading current through the collection grace period', () => {
    expect(describeRouteReading(new Date(NOW - 24 * 60 * 60 * 1000), NOW)).toEqual({
      ageSeconds: 86_400,
      stale: false,
    })
    expect(describeRouteReading(new Date(NOW - ROUTE_STALE_AFTER_MS), NOW).stale).toBe(false)
  })

  it('marks overdue readings stale without suppressing their age', () => {
    expect(describeRouteReading(new Date(NOW - 3 * 86_400_000), NOW)).toEqual({
      ageSeconds: 259_200,
      stale: true,
    })
  })
})
