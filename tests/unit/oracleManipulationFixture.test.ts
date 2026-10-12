/**
 * Methodology fork fixture: the Morpho PT-reUSD markets as they stood at the Aug-2026
 * attack block must read RED.
 *
 * Hermetic: the Pendle market state is the frozen snapshot captured at the attack block
 * (fixtures/oracle-manipulation-snapshot.json). The borrower book is reconstructed from
 * the public post-mortem (hackmd.io/@kanveuler/BJe_n1ivGe and cryptobriefing): an
 * at-risk tranche (the ~$36M that was liquidated, health 1.005–1.024 at LLTV 91.5%) plus
 * a healthy remainder, summing to the market totals. The attacker reached a −51 bps TWAP
 * move for a near-zero net cost (the Pendle YT round-trip was itself profitable), which
 * the engine must score RED.
 *
 * A separate, network-gated test (ORACLE_MANIP_LIVE=1) re-reads the same leaf live and
 * asserts the pipeline still runs end-to-end against mainnet.
 */

import { describe, it, expect } from 'vitest'
import { precompute, pendleImpactCurve, withoutLp, type PendleState } from '@/lib/oracleRegistry/manipulation/cost/pendle'
import { evaluateRatio } from '@/lib/oracleRegistry/manipulation/ratio'
import { morphoLif } from '@/lib/oracleRegistry/manipulation/ev/math'
import type { CostCurves } from '@/lib/oracleRegistry/manipulation/ratio'
import type { Exposure, PositionUsd, PriceNode } from '@/lib/oracleRegistry/manipulation/types'
import snapshot from './fixtures/oracle-manipulation-snapshot.json'

const LEAF = 'pendle:0x13285bcbc27f92b47b4edb99d744c07b48c977c0'
const LLTV = 0.915
const LINEAR_DISCOUNT = 0.98244 // Ojo linear time-to-maturity branch at the attack block

function state(): PendleState {
  return snapshot.pendlePtReusd.state as unknown as PendleState
}

/** min(Pendle TWAP(900s), linear discount) — the Ojo PT feed structure. */
function tree(ptSpot: number): PriceNode {
  return {
    op: 'min',
    value: Math.min(ptSpot, LINEAR_DISCOUNT),
    of: [
      { op: 'leaf', leafId: LEAF, read: { mode: 'twap', windowSec: 900 }, value: ptSpot, label: 'pendle' },
      { op: 'leaf', leafId: 'rate:linear', read: { mode: 'rate' }, value: LINEAR_DISCOUNT, label: 'linear' },
    ],
  }
}

function tranche(debtUsd: number, hLo: number, hHi: number, n: number): PositionUsd[] {
  return Array.from({ length: n }, (_, k) => {
    const h = hLo + (hHi - hLo) * (n > 1 ? k / (n - 1) : 0)
    const d = debtUsd / n
    return { debtUsd: d, collateralUsd: (d * h) / LLTV }
  })
}

function market(id: string, atRiskDebt: number, totalDebt: number, totalColl: number, liqUsd: number, t: PriceNode): Exposure {
  return {
    protocol: 'morpho-blue',
    id,
    label: id,
    role: 'collateral',
    tree: t,
    borrowLtv: LLTV,
    liqLtv: LLTV,
    lif: morphoLif(LLTV),
    closeFactor: 1,
    borrowableUsd: liqUsd,
    borrowableHiUsd: totalColl - totalDebt,
    liquidityKey: id,
    collateralRoomUsd: 0,
    // at-risk tranche (liquidated), then a healthy remainder up to the book total
    positions: [...tranche(atRiskDebt, 1.0053, 1.0238, 10), ...tranche(totalDebt - atRiskDebt, 1.05, 1.3, 10)],
    aggregate: { collateralUsd: totalColl, debtUsd: totalDebt },
  }
}

describe('PT-reUSD fork fixture (Aug-2026 attack block)', () => {
  const s = state()
  const ptSpot = 1 / precompute(s).e0
  const t = tree(ptSpot)
  const cost: CostCurves = {
    full: { up: pendleImpactCurve(s, 'up', 1), down: pendleImpactCurve(s, 'down', 1) },
    topKRemoved: {
      up: pendleImpactCurve(withoutLp(s, 0.5), 'up', 1),
      down: pendleImpactCurve(withoutLp(s, 0.5), 'down', 1),
    },
  }
  const exposures = [
    // USDC: ~$35.19M of $98.6M was liquidated; book collateral ~$122.6M.
    market('morpho:PT-reUSD/USDC', 35.19e6, 98.6e6, 122.6e6, 9.77e6, t),
    // USDT: ~$0.956M of $7.58M was liquidated; book collateral ~$8.97M.
    market('morpho:PT-reUSD/USDT', 0.956e6, 7.58e6, 8.97e6, 0.75e6, t),
  ]
  const result = evaluateRatio({ leafId: LEAF, exposures, cost, freeMoves: [], hardRed: null })

  it('PT spot at the attack block is ≈ 0.971', () => {
    expect(ptSpot).toBeCloseTo(0.970991, 4)
  })

  it('reads RED', () => {
    expect(result.verdict).toBe('red')
  })

  it('R_lo is below the 1.5 red threshold', () => {
    expect(result.rLo).not.toBeNull()
    expect(result.rLo!).toBeLessThan(1.5)
  })

  it('the cheapest extracting move is well under the $100M capital floor', () => {
    expect(result.cLoAtWorstUsd!).toBeLessThan(100e6)
  })

  it('the attacker-optimal move is a downward TWAP push held ~one window', () => {
    expect(result.best.lo?.direction).toBe('down')
    expect(result.best.lo?.holdSec).toBeGreaterThan(0)
  })

  it('cost / extracted at the worst point is below the 0.76 past-attack line', () => {
    // R_lo IS cost/extracted at the attacker-optimal point.
    expect(result.rLo!).toBeLessThan(0.76)
  })
})
