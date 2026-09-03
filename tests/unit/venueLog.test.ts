import { describe, expect, it } from 'vitest'

import { consequence, fmtDuration, type Entry } from '@/components/Carry/venueLogLogic'

const entry = (kind: string, prev: Record<string, unknown>, next: Record<string, unknown>): Entry => ({
  venue: 'sUSDe',
  kind,
  at: '2026-03-18T13:54:47.000Z',
  prev,
  next,
  provenance: 'reconstructed',
})

describe('VenueLog consequence rendering', () => {
  it('renders the Ethena cooldown cut as a shortened cooling window, warning tone', () => {
    const c = consequence(entry('cooldown_duration_changed', { cooldownDuration: 604800 }, { cooldownDuration: 86400 }))
    expect(c.text).toContain('cooldown 7d → 1d')
    expect(c.text).toContain('shortened')
    expect(c.tone).toBe('warning')
  })

  it('renders a lengthened cooldown loudly', () => {
    const c = consequence(entry('cooldown_duration_changed', { cooldownDuration: 86400 }, { cooldownDuration: 604800 }))
    expect(c.text).toContain('cooldown 1d → 7d')
    expect(c.text).toContain('LENGTHENED')
  })

  it('renders liquidity shifts with sign and warning only on drops', () => {
    const down = consequence(entry('instant_liquidity_shift', { instant_usd: 300_000_000 }, { instant_usd: 200_000_000 }))
    expect(down.text).toContain('$300.00M → $200.00M')
    expect(down.text).toContain('-33%')
    expect(down.tone).toBe('warning')

    const up = consequence(entry('instant_liquidity_shift', { instant_usd: 200_000_000 }, { instant_usd: 300_000_000 }))
    expect(up.text).toContain('+50%')
    expect(up.tone).toBe('normal')
  })

  it('falls back to raw prev→next for unknown kinds, never throws', () => {
    const c = consequence(entry('brand_new_kind', { a: 1 }, { a: 2 }))
    expect(c.text).toContain('brand_new_kind')
    expect(c.tone).toBe('normal')
  })

  it('formats durations in the largest clean unit', () => {
    expect(fmtDuration(604800)).toBe('7d')
    expect(fmtDuration(86400)).toBe('1d')
    expect(fmtDuration(7200)).toBe('2h')
    expect(fmtDuration(90)).toBe('90s')
  })
})
