// Shared by netApy.live.test.ts (records / checks against the chain) and
// netApyIrm.test.ts (checks the recorded fixture offline). One place builds the exact
// arguments each on-chain IRM getter receives, and one place computes our answer for
// the same arguments, so the two tests cannot drift apart.

import {
  adaptiveCurveBorrowRate,
  aaveV2Rates,
  linearKinkRate,
  sparkVariableBorrowRates,
} from '@/lib/netApy/irm'
import type { VenueSnapshot } from '@/lib/netApy/types'

export const PINNED_BLOCK = 26_120_000n
/** USD sizes per side. Borrow cases larger than the venue's cash are skipped: the
 *  chain reverts there, it does not return a rate. */
export const SIZES_USD = [0, 10_000, 1_000_000, 50_000_000, 500_000_000] as const

export type Side = 'supply' | 'borrow'

export interface IrmCase {
  venueKey: string
  side: Side
  sizeRaw: bigint
  /** What the chain returned for these exact inputs at PINNED_BLOCK. */
  onchain: { borrowRate: bigint; liquidityRate?: bigint }
}

/** The cash a borrow is drawn from, per venue. */
export function cashOf(s: VenueSnapshot): bigint {
  const st = s.state
  if (st.kind === 'aave-virtual') return st.virtualUnderlyingBalance
  if (st.kind === 'spark') return st.availableLiquidity
  if (st.kind === 'morpho-market') return st.totalSupplyAssets - st.totalBorrowAssets
  return st.cash
}

/** Our answer for one case — the same inputs the on-chain getter is called with. */
export function localRates(s: VenueSnapshot, side: Side, size: bigint): { borrowRate: bigint; liquidityRate?: bigint } {
  const supply = side === 'supply' ? size : 0n
  const borrow = side === 'borrow' ? size : 0n
  const { irm, state } = s
  if (irm.model === 'aave-rate-strategy-v2' && state.kind === 'aave-virtual') {
    const r = aaveV2Rates(irm, {
      unbacked: state.unbacked,
      liquidityAdded: supply,
      liquidityTaken: borrow,
      totalDebt: state.totalDebt + borrow,
      reserveFactor: state.reserveFactorBps,
      virtualUnderlyingBalance: state.virtualUnderlyingBalance,
    })
    return { borrowRate: r.variableBorrowRate, liquidityRate: r.liquidityRate }
  }
  if (irm.model === 'spark-variable-borrow' && state.kind === 'spark') {
    const r = sparkVariableBorrowRates(irm, {
      unbacked: state.unbacked,
      liquidityAdded: supply,
      liquidityTaken: borrow,
      totalVariableDebt: state.totalVariableDebt + borrow,
      reserveFactor: state.reserveFactorBps,
      availableLiquidityBalance: state.availableLiquidity,
    })
    return { borrowRate: r.variableBorrowRate, liquidityRate: r.liquidityRate }
  }
  if (irm.model === 'morpho-adaptive-curve' && state.kind === 'morpho-market') {
    const r = adaptiveCurveBorrowRate(
      irm.rateAtTarget,
      {
        totalSupplyAssets: state.totalSupplyAssets + supply,
        totalBorrowAssets: state.totalBorrowAssets + borrow,
        lastUpdate: state.lastUpdate,
      },
      s.anchor.blockTimestamp,
    )
    return { borrowRate: r.avgRate }
  }
  if (irm.model === 'euler-linear-kink' && state.kind === 'euler-vault') {
    return { borrowRate: linearKinkRate(irm, state.cash + supply - borrow, state.totalBorrows + borrow) }
  }
  throw new Error(`no local model for ${s.venueKey}`)
}
