import { describe, expect, it } from 'vitest'

import { observationStatus } from '@/pages/api/venues/capacity-changes'

describe('capacity change scan age', () => {
  const now = Date.parse('2026-09-27T20:00:00Z')

  it('marks a completed scan as recent within 30 hours', () => {
    expect(observationStatus('2026-09-26T15:00:00Z', now)).toBe('recent')
  })

  it('marks a missed cadence as paused, while keeping historical records available', () => {
    expect(observationStatus('2026-09-26T13:00:00Z', now)).toBe('paused')
  })

  it('does not call a future-dated scan recent', () => {
    expect(observationStatus('2026-09-28T00:00:00Z', now)).toBe('paused')
  })
})
