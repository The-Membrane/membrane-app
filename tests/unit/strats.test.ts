import { describe, expect, it } from 'vitest'

import {
  shortAddress,
  worstVerdict,
  deltaOf,
  sortByCurrentDesc,
  totalOfPositions,
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
  it('shrunk position is down', () => {
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
