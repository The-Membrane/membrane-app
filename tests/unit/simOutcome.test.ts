import { describe, expect, it } from 'vitest'

import { fmtUtcMinute, outcomeLine } from '@/lib/position-sim/outcome'
import type { Comparison, SimEvent, SimRun } from '@/lib/position-sim/types'

// 2025-10-10 21:14:00 UTC
const T1 = Date.UTC(2025, 9, 10, 21, 14) / 1000
// 2025-10-11 02:03:00 UTC
const T2 = Date.UTC(2025, 9, 11, 2, 3) / 1000

const ev = (kind: SimEvent['kind'], ts: number): SimEvent => ({
  minute: 0,
  ts,
  kind,
  ltv: 0.8,
  line: 0.8,
  repaidUsd: 1,
  seizedUsd: kind === 'liquidation' ? 1 : 0,
  recalledUsd: kind === 'recall' || kind === 'cure' ? 1 : 0,
  penaltyUsd: 0,
  why: '',
})

const run = (engine: 'source' | 'membrane', events: SimEvent[], wiped = false): SimRun => ({
  engine,
  label: engine === 'source' ? 'Aave V3' : 'Membrane',
  events,
  endCollateralUsd: 0,
  endDebtUsd: 0,
  endDeployedUsd: 0,
  startEquityUsd: 0,
  endEquityUsd: 0,
  penaltyPaidUsd: 0,
  peakLtv: 0,
  wiped,
  equitySeries: [],
  ltvSeries: [],
  provenance: 'modelled' as any,
  caveats: [],
})

const cmp = (source: SimRun, membrane: SimRun): Comparison =>
  ({
    position: { label: 'Aave V3' } as any,
    source,
    membrane,
    equityDeltaUsd: 0,
    unpricedSymbols: [],
    scenarioLabel: '',
  }) as Comparison

describe('outcomeLine', () => {
  it('formats the UTC minute of the price path', () => {
    expect(fmtUtcMinute(T1)).toBe('10 Oct 21:14 UTC')
    expect(fmtUtcMinute(T2)).toBe('11 Oct 02:03 UTC')
  })

  it('liquidated there, survived here', () => {
    const o = outcomeLine(cmp(run('source', [ev('liquidation', T1)]), run('membrane', [ev('recall', T1)])))
    expect(o.line).toBe('Liquidated on Aave V3 at 10 Oct 21:14 UTC · survived on Membrane')
    expect(o.membrane.liquidated).toBe(false)
  })

  it('a cure or recall on Membrane is survival, not a liquidation', () => {
    const o = outcomeLine(
      cmp(run('source', []), run('membrane', [ev('breach', T1), ev('cure', T2), ev('recall', T2)])),
    )
    expect(o.line).toBe('Survived on Aave V3 · survived on Membrane')
  })

  it('never hides a Membrane liquidation', () => {
    const o = outcomeLine(cmp(run('source', []), run('membrane', [ev('liquidation', T2)])))
    expect(o.line).toBe('Survived on Aave V3 · liquidated on Membrane at 11 Oct 02:03 UTC')
  })

  it('both liquidated: both times, source first', () => {
    const o = outcomeLine(cmp(run('source', [ev('liquidation', T1)]), run('membrane', [ev('liquidation', T2)])))
    expect(o.line).toBe(
      'Liquidated on Aave V3 at 10 Oct 21:14 UTC · liquidated on Membrane at 11 Oct 02:03 UTC',
    )
  })

  it('wiped is named, never softened to liquidated', () => {
    const o = outcomeLine(cmp(run('source', [ev('liquidation', T1)], true), run('membrane', [])))
    expect(o.line).toBe('Wiped out on Aave V3 at 10 Oct 21:14 UTC · survived on Membrane')
  })

  it('uses the first liquidation, not a later one', () => {
    const o = outcomeLine(
      cmp(run('source', [ev('breach', T1 - 60), ev('liquidation', T1), ev('liquidation', T2)]), run('membrane', [])),
    )
    expect(o.source.firstAt).toBe(T1)
  })
})
