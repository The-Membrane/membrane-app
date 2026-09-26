import { describe, expect, it } from 'vitest'

import {
  shortAddress,
  worstVerdict,
  deltaOf,
  sortByCurrentDesc,
  totalOfPositions,
  venueFlows,
  filterStrats,
  type StratRow,
} from '@/components/Strats/stratsLogic'
import type { Verdict } from '@/components/Radar/radarLogic'

// Carry Strats board logic — pure derivations only (anonymization, weakest-prong
// composite, entry→now delta, board ordering, entry-baseline total). No chain, no
// db: these are the honest transforms the API and dashboard both depend on.

describe('shortAddress', () => {
  it('anonymizes to 0x1234…abcd while the full address is carried separately', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdefABCDEF12')).toBe('0x1234…EF12')
  })
  it('leaves a non-address string untouched (never fabricates a shape)', () => {
    expect(shortAddress('not-an-address')).toBe('not-an-address')
  })
})

describe('worstVerdict — weakest prong, never averaged', () => {
  const V = (xs: Verdict[]) => worstVerdict(xs)
  it('empty (nothing held) is clear', () => {
    expect(V([])).toBe('clear')
  })
  it('all clear is clear', () => {
    expect(V(['clear', 'clear'])).toBe('clear')
  })
  it('a single caution among clears governs', () => {
    expect(V(['clear', 'caution', 'clear'])).toBe('caution')
  })
  it('exposed dominates caution and clear (most severe wins)', () => {
    expect(V(['caution', 'exposed', 'clear'])).toBe('exposed')
  })
})

describe('deltaOf — arithmetic, honest null baseline', () => {
  it('no entry baseline ⇒ null delta and null dir (never a fake 0)', () => {
    expect(deltaOf(null, 500_000)).toEqual({ delta: null, dir: null })
  })
  it('grown position is up', () => {
    expect(deltaOf(100_000, 150_000)).toEqual({ delta: 50_000, dir: 'up' })
  })
  it('a withdrawal-like shrink is down, not an earnings calculation', () => {
    expect(deltaOf(200_000, 120_000)).toEqual({ delta: -80_000, dir: 'down' })
  })
  it('unchanged position is flat', () => {
    expect(deltaOf(300_000, 300_000)).toEqual({ delta: 0, dir: 'flat' })
  })
})

describe('sortByCurrentDesc — largest current position first', () => {
  it('orders by current_total_usd descending without mutating the input', () => {
    const rows = [
      { address: 'a', current_total_usd: 100 },
      { address: 'b', current_total_usd: 900 },
      { address: 'c', current_total_usd: 400 },
    ]
    const sorted = sortByCurrentDesc(rows)
    expect(sorted.map((r) => r.address)).toEqual(['b', 'c', 'a'])
    // input untouched (stable, non-mutating)
    expect(rows.map((r) => r.address)).toEqual(['a', 'b', 'c'])
  })
})

describe('totalOfPositions — entry-baseline total', () => {
  it('sums .usd across an entry snapshot', () => {
    expect(totalOfPositions([{ usd: 100_000 }, { usd: 250_000 }])).toBe(350_000)
  })
  it('null / non-array ⇒ null (no baseline, never a fabricated 0)', () => {
    expect(totalOfPositions(null)).toBeNull()
    expect(totalOfPositions(undefined)).toBeNull()
  })
  it('ignores non-numeric usd entries safely', () => {
    expect(totalOfPositions([{ usd: 100 }, {} as { usd?: number }])).toBe(100)
  })
})

const sampleRows = [
  {
    address: '0x1111111111111111111111111111111111111111',
    label: 'Yield desk',
    current_total_usd: 300,
    held: [
      { venue: 'susds', label: 'sUSDS', usd: 200, verdict: 'clear' },
      { venue: 'scrvusd', label: 'scrvUSD', usd: 100, verdict: 'caution' },
    ],
    verdict: 'caution',
  },
  {
    address: '0x2222222222222222222222222222222222222222',
    label: null,
    current_total_usd: 150,
    held: [{ venue: 'susds', label: 'sUSDS', usd: 150, verdict: 'clear' }],
    verdict: 'clear',
  },
] as StratRow[]

describe('tracked-capital flow and filters', () => {
  it('groups current venue holdings without confusing them with transfers', () => {
    expect(venueFlows(sampleRows)).toEqual([
      { venue: 'susds', label: 'sUSDS', usd: 350, books: 2 },
      { venue: 'scrvusd', label: 'scrvUSD', usd: 100, books: 1 },
    ])
  })
  it('filters the detail rows by address or label, venue, and weakest verdict', () => {
    expect(filterStrats(sampleRows, 'Yield', 'scrvusd', 'caution').map((row) => row.label)).toEqual(
      ['Yield desk'],
    )
    expect(filterStrats(sampleRows, '0x2222', 'susds', 'clear')).toHaveLength(1)
    expect(filterStrats(sampleRows, '', 'scrvusd', 'clear')).toHaveLength(0)
  })
})
