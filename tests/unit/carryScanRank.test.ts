import { describe, expect, it } from 'vitest'

import { rankAtSize } from '@/lib/carryScan/rank'
import type { ScoutRow, SizeKey } from '@/lib/carryScan/types'

// Minimal rows: rankAtSize reads carryA / carryABase at the size, count and tvlUsd only.
const row = (label: string, a: Partial<Record<SizeKey, number | null>>, tvlUsd = 1e8) =>
  ({
    label,
    count: 100,
    tvlUsd,
    carryA: {
      '100k': a['100k'] == null ? null : { apy: a['100k'] },
      '1m': a['1m'] == null ? null : { apy: a['1m'] },
      '10m': a['10m'] == null ? null : { apy: a['10m'] },
    },
    carryABase: { '100k': null, '1m': null, '10m': null },
  }) as unknown as ScoutRow

describe('rankAtSize', () => {
  it('ranks only rows whose (a) is positive at the selected size (refuter R1)', () => {
    const rows = [
      row('humaUSDC', { '100k': 3.04, '1m': -0.4 }),
      row('steakUSDC', { '100k': 2.7, '1m': 1.2 }),
      row('zero', { '100k': 0.5, '1m': 0 }),
      row('thin', { '100k': 0.2, '1m': null }),
    ]
    const out = rankAtSize(rows, '1m')
    expect(out.map((x) => [x.row.label, x.rank])).toEqual([
      ['steakUSDC', 1],
      ['humaUSDC', null],
      ['zero', null],
      ['thin', null],
    ])
  })

  it('orders positive rows by (a) at that size', () => {
    const rows = [row('b', { '100k': 1 }), row('a', { '100k': 2 })]
    expect(rankAtSize(rows, '100k').map((x) => [x.row.label, x.rank])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })
})
