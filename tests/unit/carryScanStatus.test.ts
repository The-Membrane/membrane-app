import { describe, expect, it } from 'vitest'

import { computeStatuses, type CurrentRow } from '@/lib/carryScan/status'
import type { PastWeek, ScoutList } from '@/lib/carryScan/types'

const K = (n: number) => `1:0x${String(n).padStart(40, '0')}`
const week = (
  w: string,
  keys: number[],
  extra: { key: string; list: ScoutList }[] = [],
): PastWeek => ({
  week: w,
  rows: [
    ...keys.map((n) => ({
      key: K(n),
      list: 'ranked' as ScoutList,
      label: `v${n}`,
      aliases: [`llama:uuid-${n}`],
    })),
    ...extra,
  ],
})
const cur = (n: number, a = 0.01, list: ScoutList = 'ranked'): CurrentRow => ({
  key: K(n),
  aliases: [`llama:uuid-${n}`],
  list,
  carryA100k: a,
  label: `v${n}`,
  protocol: 'p',
  stable: 'USDC',
})

describe('S7 status against the last 8 weekly files', () => {
  it('NEW, STILL with weeks in a row, RETURNING', () => {
    const past = [week('2026-W38', [1, 3]), week('2026-W39', [1]), week('2026-W40', [1, 2])]
    const s = computeStatuses([cur(1), cur(2), cur(3), cur(4)], past, new Set(), new Map())
    expect(s.byKey.get(K(1))).toMatchObject({ status: 'STILL', weeksInRow: 4 })
    expect(s.byKey.get(K(2))).toMatchObject({ status: 'STILL', weeksInRow: 2 })
    expect(s.byKey.get(K(3))).toMatchObject({ status: 'RETURNING', weeksInRow: 1 })
    expect(s.byKey.get(K(4))).toMatchObject({ status: 'NEW', weeksInRow: 1 })
    expect(s.newCount).toBe(1)
  })

  it('a flickering row is RETURNING, not NEW again, inside the 8-week window — and NEW once it falls out', () => {
    const inWindow = [
      week('2026-W33', [7]),
      ...['W34', 'W35', 'W36', 'W37', 'W38', 'W39', 'W40'].map((w) => week(`2026-${w}`, [])),
    ]
    expect(computeStatuses([cur(7)], inWindow, new Set(), new Map()).byKey.get(K(7))?.status).toBe(
      'RETURNING',
    )
    const outOfWindow = [
      week('2026-W32', [7]),
      ...['W33', 'W34', 'W35', 'W36', 'W37', 'W38', 'W39', 'W40'].map((w) => week(`2026-${w}`, [])),
    ]
    expect(
      computeStatuses([cur(7)], outOfWindow, new Set(), new Map()).byKey.get(K(7))?.status,
    ).toBe('NEW')
  })

  it('DROPPED lists the gate the row failed; NOW ON APP is a success note, not a drop', () => {
    const past = [week('2026-W40', [1, 2, 5])]
    const gates = new Map([['llama:uuid-2', 'filter: TVL under $10M']])
    const s = computeStatuses(
      [cur(1), { ...cur(5, 0.01, 'unverified'), key: null, unrankedReason: 'x' }],
      past,
      new Set([K(5)]),
      gates,
    )
    expect(s.dropped).toEqual([
      expect.objectContaining({
        key: K(2),
        failedGate: 'filter: TVL under $10M',
        lastPassedWeek: '2026-W40',
      }),
    ])
    expect(s.nowOnApp).toEqual([expect.objectContaining({ key: K(5) })])
  })

  it('a row still listed but unranked is DROPPED with its reason', () => {
    const s = computeStatuses(
      [{ ...cur(9, 0.01, 'unverified'), unrankedReason: 'totalAssets not within ±15%' }],
      [week('2026-W40', [9])],
      new Set(),
      new Map(),
    )
    expect(s.dropped[0]).toMatchObject({ key: K(9), failedGate: 'totalAssets not within ±15%' })
    // The scan lists an unverified row without a key: it is matched by its DeFiLlama alias.
    const keyless = computeStatuses(
      [{ ...cur(9, 0.01, 'unverified'), key: null, unrankedReason: 'no address resolver' }],
      [week('2026-W40', [9])],
      new Set(),
      new Map(),
    )
    expect(keyless.dropped[0]).toMatchObject({ key: K(9), failedGate: 'no address resolver' })
  })

  it('persistent: (a) positive in at least 3 of the last 4 weekly files, once 4 exist', () => {
    const wk = (w: string, a: number | null) => ({
      week: w,
      rows: [
        {
          key: K(1),
          list: 'ranked' as ScoutList,
          carryA: {
            '100k': a === null ? null : { apy: a, bound: 'exact' as const },
            '1m': null,
            '10m': null,
          },
        },
      ],
    })
    expect(
      computeStatuses(
        [cur(1)],
        [wk('2026-W39', 0.01), wk('2026-W40', 0.01)],
        new Set(),
        new Map(),
      ).byKey.get(K(1))?.persistent,
    ).toBeNull()
    expect(
      computeStatuses(
        [cur(1)],
        [wk('2026-W38', -0.01), wk('2026-W39', 0.01), wk('2026-W40', 0.01)],
        new Set(),
        new Map(),
      ).byKey.get(K(1))?.persistent,
    ).toBe(true)
    expect(
      computeStatuses(
        [cur(1, -0.01)],
        [wk('2026-W38', -0.01), wk('2026-W39', 0.01), wk('2026-W40', 0.01)],
        new Set(),
        new Map(),
      ).byKey.get(K(1))?.persistent,
    ).toBe(false)
  })
})
