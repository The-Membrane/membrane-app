import { describe, expect, it } from 'vitest'

import { observationStatus } from '@/pages/api/venues/capacity-changes'

describe('capacity change observation and chain coverage age', () => {
  const now = Date.parse('2026-09-27T20:00:00Z')

  it('marks both clocks recent at the inclusive 30-hour boundary', () => {
    expect(observationStatus('2026-09-26T14:00:00Z', '2026-09-26T14:00:00Z', now)).toBe('recent')
  })

  it('pauses when either the local check or covered block is older than 30 hours', () => {
    expect(observationStatus('2026-09-26T13:00:00Z', '2026-09-26T15:00:00Z', now)).toBe('paused')
    expect(observationStatus('2026-09-26T15:00:00Z', '2026-09-26T13:00:00Z', now)).toBe('paused')
  })

  it('does not call either future-dated clock recent', () => {
    expect(observationStatus('2026-09-28T00:00:00Z', '2026-09-26T15:00:00Z', now)).toBe('paused')
    expect(observationStatus('2026-09-26T15:00:00Z', '2026-09-28T00:00:00Z', now)).toBe('paused')
  })
})
