/**
 * S4 THE TWO CARRY COLUMNS.
 *
 * (a) MARKET CARRY = venueNetApy(size) − Bench(stable, size). Ranked on.
 *     venueNetApy keeps only plain-deposit incentives (lib/netApy/breakdown.ts drops
 *     conditional campaigns; fixed-budget campaigns dilute by size). (a) is also kept
 *     base-only, with no incentives. A DeFiLlama-only row is priced at size as
 *     apy × TVL/(TVL+size), labelled `projected`; a size above 5% of TVL is not priced
 *     ("size > 5% of TVL") and the row is unranked at that size.
 *
 * (b) MEMBRANE CARRY = aprToApy(membraneSplit(gainApr(size), shares).user), shown for
 *     EVERY row (owner, 2026-10-10). No borrow term: deployed debt is paid for with a
 *     curator-set share of the venue's yield (components/Simulator/FinePrint.tsx
 *     CARRY_TERMS), which is what the split takes. Two figures:
 *       base          base yield only — what the vaults collect today;
 *       withRewards   base + eligible incentives, "if vaults claim rewards (not yet)".
 *     The shares have no default: deploy leaves both unset and a share of 0 throws
 *     (validShare). With no share, (b) is an UPPER bound: "≤ x% · curator-set".
 *
 * Every Carry carries a label class (lib/netApy/types.ts): (a) takes the weaker of its
 * venue figure and its benchmark, (b) the class of the gain it splits.
 *
 * Nothing here is a promise of positive carry: (a) is the spread measured at the scan.
 */

import {
  membraneSplit,
  validShare,
  type MembraneShareInput,
  type NetBreakdown,
} from '../netApy/breakdown'
import { aprToApy } from '../netApy/fixedPoint'
import type { LabelClass } from '../netApy/types'
import {
  SCAN_SIZES_USD,
  sizeKeyOf,
  THRESHOLDS,
  type BenchRef,
  type Carry,
  type CarryB,
  type LlamaPool,
  type SizeKey,
  type Valued,
} from './types'

export const WITH_REWARDS_NOTE = 'if vaults claim rewards (not yet)'
export const SIZE_OVER_TVL_NOTE = 'size > 5% of TVL'

/** Inverse of aprToApy (per-second compounding): apr = ln(1 + apy). */
export const apyToApr = (apy: number): number => Math.log1p(apy)

/** The share inputs, validated like /api/net-apy: a share must be in (0, 1]; 0 throws. */
export function checkedShare(share: MembraneShareInput = {}): MembraneShareInput {
  return {
    protocolShare: validShare('protocolShare', share.protocolShare),
    curatorShare: validShare('curatorShare', share.curatorShare),
  }
}

/** A DeFiLlama APY (fraction) at a deposit size: apy × TVL/(TVL+size); unpriced above 5% of TVL. */
export function reportedAtSize(apy: number, tvlUsd: number, sizeUsd: number): Valued {
  if (!(tvlUsd > 0) || sizeUsd > THRESHOLDS.maxSizeShareOfTvl * tvlUsd) {
    return { apy: null, apr: null, labelClass: 'projected', note: SIZE_OVER_TVL_NOTE }
  }
  const v = (apy * tvlUsd) / (tvlUsd + sizeUsd)
  return {
    apy: v,
    apr: apyToApr(v),
    labelClass: 'projected',
    note: 'DeFiLlama APY × TVL/(TVL+size)',
  }
}

/** Headline APY as a fraction. */
export const headlineApy = (p: LlamaPool): number => (p.apy ?? 0) / 100

/** Base APY as a fraction: apyBase, else apy − apyReward (some pools report base as null). */
export function baseApy(p: LlamaPool): number {
  if (p.apyBase !== null && p.apyBase !== undefined && Number.isFinite(p.apyBase))
    return Math.max(0, p.apyBase) / 100
  return Math.max(0, (p.apy ?? 0) - Math.max(0, p.apyReward ?? 0)) / 100
}

export function venueColumnsFromLlama(p: LlamaPool): {
  venueNet: Record<SizeKey, Valued>
  venueNetBase: Record<SizeKey, Valued>
} {
  const venueNet = {} as Record<SizeKey, Valued>
  const venueNetBase = {} as Record<SizeKey, Valued>
  for (const size of SCAN_SIZES_USD) {
    venueNet[sizeKeyOf(size)] = reportedAtSize(headlineApy(p), p.tvlUsd, size)
    venueNetBase[sizeKeyOf(size)] = reportedAtSize(baseApy(p), p.tvlUsd, size)
  }
  return { venueNet, venueNetBase }
}

/**
 * Venue columns from on-chain breakdowns (supply side, no share given). With no share the
 * Membrane split leaves the whole gain to the user, so `net` IS the venue's net here.
 */
export function venueColumnsFromBreakdowns(bySize: Record<SizeKey, NetBreakdown>): {
  venueNet: Record<SizeKey, Valued>
  venueNetBase: Record<SizeKey, Valued>
} {
  const venueNet = {} as Record<SizeKey, Valued>
  const venueNetBase = {} as Record<SizeKey, Valued>
  for (const size of SCAN_SIZES_USD) {
    const k = sizeKeyOf(size)
    const b = bySize[k]
    const note = b.checks.reverts ? `this size reverts on-chain: ${b.checks.reverts}` : undefined
    const priced = !b.checks.reverts
    venueNet[k] = {
      apy: priced ? b.net.apy : null,
      apr: priced ? b.net.apr : null,
      labelClass: 'projected',
      note,
    }
    venueNetBase[k] = {
      apy: priced ? b.netIncentiveFree.apy : null,
      apr: priced ? b.netIncentiveFree.apr : null,
      labelClass: 'projected',
      note,
    }
  }
  return { venueNet, venueNetBase }
}

/** Label classes from strongest to weakest claim; a figure built from two takes the weaker. */
const CLASS_ORDER: readonly LabelClass[] = [
  'measured',
  'derived',
  'projected',
  'reported',
  'curator-set',
]
export const weakerClass = (a: LabelClass, b: LabelClass): LabelClass =>
  CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b) ? a : b

/** (a) at one size. Null when there is no same-stable benchmark or the size is unpriced. */
export function carryAOf(v: Valued, bench: BenchRef | null): Carry | null {
  if (!bench || v.apy === null) return null
  return {
    apy: v.apy - bench.apy,
    bound: 'exact',
    labelClass: weakerClass(v.labelClass, bench.labelClass),
  }
}

/** (b) at one size, through the CuratorVault split. Throws on a share of 0. */
export function carryBOf(gain: Valued, share: MembraneShareInput = {}): Carry {
  const s = checkedShare(share)
  if (gain.apr === null)
    return { apy: null, bound: 'upper', labelClass: gain.labelClass, note: gain.note }
  const split = membraneSplit(gain.apr, s)
  return { apy: aprToApy(split.user), bound: split.bound, labelClass: gain.labelClass }
}

export function carryBPair(
  base: Valued,
  withRewards: Valued,
  share: MembraneShareInput = {},
): CarryB {
  return {
    base: carryBOf(base, share),
    withRewards: { ...carryBOf(withRewards, share), note: WITH_REWARDS_NOTE },
  }
}
