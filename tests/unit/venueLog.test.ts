import { describe, expect, it } from 'vitest'

import {
  capacityMove,
  consequence,
  fmtDuration,
  type Entry,
} from '@/components/Carry/venueLogLogic'

const entry = (
  kind: string,
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Entry => ({
  venue: 'sUSDe',
  kind,
  at: '2026-03-18T13:54:47.000Z',
  prev,
  next,
  provenance: 'reconstructed',
})

describe('VenueLog consequence rendering', () => {
  it('shows the venue, dollar delta and measured window for a capacity move', () => {
    const move = capacityMove({
      ...entry('param_changed', { depth_usd: 24_589_947.676515 }, { depth_usd: 30_505_294.031558 }),
      venue: 'scrvUSD',
      provenance: 'observed',
      at: '2026-09-21T21:25:02.474Z',
      since: '2026-09-21T05:15:22.074Z',
    })
    expect(move).toMatchObject({
      venue: 'scrvUSD',
      metric: 'instant swap-out depth',
      change: 'rose $5.92M',
      from: '$24.59M',
      to: '$30.51M',
      window: 'over 16h',
    })
    expect(capacityMove(entry('terms_page_changed', {}, {}))).toBeNull()
  })

  it('renders the Ethena cooldown cut as a shortened cooling window, warning tone', () => {
    const c = consequence(
      entry('cooldown_duration_changed', { cooldownDuration: 604800 }, { cooldownDuration: 86400 }),
    )
    expect(c.text).toContain('cooldown 7d → 1d')
    expect(c.text).toContain('shortened')
    expect(c.tone).toBe('warning')
  })

  it('renders a lengthened cooldown loudly', () => {
    const c = consequence(
      entry('cooldown_duration_changed', { cooldownDuration: 86400 }, { cooldownDuration: 604800 }),
    )
    expect(c.text).toContain('cooldown 1d → 7d')
    expect(c.text).toContain('LENGTHENED')
  })

  it('renders liquidity shifts with sign and warning only on drops', () => {
    const down = consequence(
      entry('instant_liquidity_shift', { instant_usd: 300_000_000 }, { instant_usd: 200_000_000 }),
    )
    expect(down.text).toContain('$300.00M → $200.00M')
    expect(down.text).toContain('-33%')
    expect(down.tone).toBe('warning')

    const up = consequence(
      entry('instant_liquidity_shift', { instant_usd: 200_000_000 }, { instant_usd: 300_000_000 }),
    )
    expect(up.text).toContain('+50%')
    expect(up.tone).toBe('normal')
  })

  it('names an unknown kind and never dumps JSON', () => {
    const c = consequence(entry('brand_new_kind', { a: 1 }, { a: 2 }))
    expect(c.text).toBe('brand new kind recorded')
    expect(c.text).not.toContain('{')
    expect(c.tone).toBe('normal')
  })

  it('terms_page_changed says the page was edited, never the hash', () => {
    const c = consequence(
      entry(
        'terms_page_changed',
        { content_len: 6229, content_hash: 'aa' },
        { content_len: 6300, content_hash: 'bb' },
      ),
    )
    expect(c.text).toBe('terms page edited (+71 chars) — read it before you rely on it')
    expect(c.text).not.toContain('aa')
    expect(c.tone).toBe('warning')
  })

  it('param_changed renders each changed key by name, USD keys as dollars', () => {
    const c = consequence(
      entry('param_changed', { depth_usd: 24589947.6 }, { depth_usd: 30505294.0 }),
    )
    expect(c.text).toBe('instant swap-out depth $24.59M → $30.51M')
    const w = consequence({
      ...entry('param_changed', { depth_usd: 1e6 }, { depth_usd: 2e6 }),
      at: '2026-09-21T06:00:00Z',
      since: '2026-09-21T05:00:00Z',
    })
    expect(w.text).toBe('instant swap-out depth $1.00M → $2.00M over 1h')
    const d = consequence({
      ...entry('param_changed', { depth_usd: 1e6 }, { depth_usd: 2e6 }),
      at: '2026-09-21T06:00:00Z',
      since: '2026-09-15T06:00:00Z',
    })
    expect(d.text).toMatch(/ over 6d$/)
    expect(c.tone).toBe('normal')
    expect(consequence(entry('param_changed', { depth_usd: 30e6 }, { depth_usd: 14e6 })).tone).toBe(
      'warning',
    )
  })

  it('formats durations in the largest clean unit', () => {
    expect(fmtDuration(604800)).toBe('7d')
    expect(fmtDuration(86400)).toBe('1d')
    expect(fmtDuration(7200)).toBe('2h')
    expect(fmtDuration(90)).toBe('90s')
  })
})
