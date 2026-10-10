import { describe, expect, it } from 'vitest'

import { recordedAgeLabel } from '@/lib/venueCapacity/readingAge'

describe('capacity curve recording age', () => {
  const recordedAt = '2026-09-27T06:00:00.000Z'

  it('waits for the client clock before showing an age', () => {
    expect(recordedAgeLabel(recordedAt, null)).toBeNull()
  })

  it('shows recent age without marking a daily reading stale', () => {
    expect(recordedAgeLabel(recordedAt, Date.parse('2026-09-27T06:37:00.000Z'))).toBe(
      'Recorded 37m ago',
    )
    expect(recordedAgeLabel(recordedAt, Date.parse('2026-09-27T15:00:00.000Z'))).toBe(
      'Recorded 9h ago',
    )
  })

  it('keeps older readings visible and labels their age', () => {
    expect(recordedAgeLabel(recordedAt, Date.parse('2026-09-28T08:00:00.000Z'))).toBe(
      'Stale · 1d 2h old',
    )
  })

  it('does not turn an invalid or future source time into freshness', () => {
    expect(recordedAgeLabel('invalid', Date.parse('2026-09-27T08:00:00.000Z'))).toBe(
      'Recording time unavailable',
    )
    expect(recordedAgeLabel(recordedAt, Date.parse('2026-09-27T05:00:00.000Z'))).toBe(
      'Recording time unavailable',
    )
  })
})
