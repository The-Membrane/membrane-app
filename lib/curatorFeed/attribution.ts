/**
 * Attribution of borrow-rate spikes / liquidity drains to vault reallocations. Pure.
 *
 * Inputs per case (collector, archive eth_call): Morpho Blue `market(id)` and the IRM's
 * `borrowRateView` at the END of block b−1 and the END of block b, where b holds one or
 * more large reallocation withdrawals from that market. The state difference covers the
 * WHOLE block (every tx in it), so the result says how much of the block's supply drop
 * the vault withdrawals account for — it never claims more than that.
 *
 * Rates: Morpho Blue IRMs return a per-second WAD rate; APR here is simple
 * (rate × seconds-per-year), not compounded, and is labelled so.
 */

import type { AttributionCase } from './types'

export const SECONDS_PER_YEAR = 31_536_000
const WAD = 10n ** 18n

export interface SpikeThresholds {
  /** aprAfter ≥ ratio × aprBefore … */
  ratio: number
  /** … and aprAfter − aprBefore ≥ this many APR points (0.02 = 2 pp). */
  minDeltaApr: number
  /** utilization at or above this after the block = drained. */
  drainedUtil: number
}
export const DEFAULT_SPIKE: SpikeThresholds = { ratio: 1.5, minDeltaApr: 0.02, drainedUtil: 0.99 }

export interface Attribution {
  market: string
  block: number
  ts: number
  /** Sum of vault reallocation withdrawals in the block (loan-token base units). */
  withdrawn: bigint
  supplyBefore: bigint
  supplyAfter: bigint
  /** supplyAfter − supplyBefore (negative = supply fell). */
  supplyDelta: bigint
  /** withdrawn / −supplyDelta, clamped to [0, 1]; undefined when supply did not fall. */
  shareOfDrop?: number
  utilBefore: number
  utilAfter: number
  aprBefore?: number
  aprAfter?: number
  spike: boolean
  drained: boolean
  vaults: string[]
}

/** bigint ratio → float with 1e-9 resolution, safe for any token size. */
export const ratio = (num: bigint, den: bigint): number =>
  den === 0n ? 0 : Number((num * 1_000_000_000n) / den) / 1e9

export const aprOf = (ratePerSecondWad: bigint): number =>
  ratio(ratePerSecondWad * BigInt(SECONDS_PER_YEAR), WAD)

export function attribute(
  c: AttributionCase,
  t: SpikeThresholds = DEFAULT_SPIKE,
): Attribution | null {
  if (!c.before || !c.after) return null
  const supplyBefore = BigInt(c.before.totalSupplyAssets)
  const supplyAfter = BigInt(c.after.totalSupplyAssets)
  const borrowBefore = BigInt(c.before.totalBorrowAssets)
  const borrowAfter = BigInt(c.after.totalBorrowAssets)
  const withdrawn = c.legs.reduce((s, l) => s + BigInt(l.assets), 0n)
  const supplyDelta = supplyAfter - supplyBefore
  const shareOfDrop = supplyDelta < 0n ? Math.min(1, ratio(withdrawn, -supplyDelta)) : undefined
  const utilBefore = ratio(borrowBefore, supplyBefore)
  const utilAfter = ratio(borrowAfter, supplyAfter)
  const aprBefore =
    c.before.borrowRate !== undefined ? aprOf(BigInt(c.before.borrowRate)) : undefined
  const aprAfter = c.after.borrowRate !== undefined ? aprOf(BigInt(c.after.borrowRate)) : undefined
  const spike =
    aprBefore !== undefined &&
    aprAfter !== undefined &&
    aprAfter >= t.ratio * aprBefore &&
    aprAfter - aprBefore >= t.minDeltaApr
  return {
    market: c.market,
    block: c.block,
    ts: c.ts,
    withdrawn,
    supplyBefore,
    supplyAfter,
    supplyDelta,
    shareOfDrop,
    utilBefore,
    utilAfter,
    aprBefore,
    aprAfter,
    spike,
    drained: utilAfter >= t.drainedUtil,
    vaults: [...new Set(c.legs.map((l) => l.vault))],
  }
}
