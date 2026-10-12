/**
 * EV of a price move against one or many lending exposures. Pure math.
 *
 * r is the factor on the market's collateral/debt price ratio (r > 1: collateral
 * overvalued or debt undervalued).
 *
 * UPSIDE (r > 1), borrow-and-walk: deposit collateral worth V at the true price, borrow
 * borrowLtv·V·r of true value, walk away. Profit V·(borrowLtv·r − 1), positive only
 * when r > 1/borrowLtv. V is bounded by the borrowable liquidity (shared across
 * exposures with one liquidityKey) and by the collateral supply-cap headroom.
 *
 * DOWNSIDE (r < 1), liquidation capture: a position (C, D) at the current price is
 * liquidatable once D > C·r·liqLtv. Repaying R seizes collateral worth R·lif/r at the
 * true price (capped at C): profit min(R·lif/r, C) − R with R ≤ closeFactor·D. With
 * no position data the bound assumes every position sits at the edge.
 */

import type { Exposure, PositionUsd } from '../types'

/** Effective LIF of one position after the move (Euler's discount grows as HF falls). */
function lifFor(e: Exposure, hf: number): number {
  if (e.dynamicDiscountCap === undefined) return e.lif
  const discount = Math.min(e.dynamicDiscountCap, Math.max(0, 1 - hf))
  return 1 / (1 - discount)
}

export function positionCapture(e: Exposure, p: PositionUsd, r: number): number {
  if (r >= 1 || p.debtUsd <= 0 || p.collateralUsd <= 0) return 0
  const hf = (p.collateralUsd * r * e.liqLtv) / p.debtUsd
  if (hf >= 1) return 0
  const lif = lifFor(e, hf)
  const maxRepay = e.closeFactor * p.debtUsd
  if ((maxRepay * lif) / r <= p.collateralUsd) return maxRepay * (lif / r - 1)
  // Collateral runs out first: repay just enough to take all of it.
  return p.collateralUsd * (1 - r / lif)
}

/**
 * Downside capture. With per-borrower positions, both the point and the upper bound use
 * them. Without, only the upper bound (`hi`) uses the aggregate-edge assumption (every
 * position at the liquidation edge); the point estimate is withheld (0) and the caller
 * flags the gap, so a market with no position data never inflates R_pt.
 */
export function downsideEv(e: Exposure, r: number, mode: 'pt' | 'hi' = 'pt'): number {
  if (r >= 1) return 0
  if (e.positions) return e.positions.reduce((a, p) => a + positionCapture(e, p, r), 0)
  if (mode === 'pt') return 0
  const { collateralUsd: C, debtUsd: D } = e.aggregate
  if (C <= 0 || D <= 0) return 0
  return Math.max(0, Math.min(C * (1 - r / e.lif), e.closeFactor * D * (e.lif / r - 1)))
}

/** Per-exposure upside before liquidity sharing: profit per USD borrowed and the cap. */
function upsideTerms(e: Exposure, r: number, liq: 'pt' | 'hi'): { k: number; maxBorrow: number } | null {
  if (r <= 1) return null
  const k = e.borrowLtv * r
  if (k <= 1) return null
  const room = e.role === 'collateral' ? e.collateralRoomUsd : Infinity
  const borrowable = liq === 'hi' ? (e.borrowableHiUsd ?? e.borrowableUsd) : e.borrowableUsd
  return { k, maxBorrow: Math.min(borrowable, room * k) }
}

export function upsideEv(e: Exposure, r: number, liq: 'pt' | 'hi' = 'pt'): number {
  const t = upsideTerms(e, r, liq)
  return t ? t.maxBorrow * (1 - 1 / t.k) : 0
}

export interface EvBreakdown {
  totalUsd: number
  upsideUsd: number
  downsideUsd: number
  byExposure: { id: string; upsideUsd: number; downsideUsd: number; r: number }[]
}

/**
 * EV across exposures, each with its own ratio factor. Upside shares liquidity per
 * liquidityKey: the pool is filled in order of profit per USD borrowed, and a key's
 * pool size is the largest borrowableUsd any of its exposures reports.
 */
export function totalEv(exposures: Exposure[], ratios: number[], liq: 'pt' | 'hi' = 'pt'): EvBreakdown {
  const borrowableOf = (e: Exposure) => (liq === 'hi' ? (e.borrowableHiUsd ?? e.borrowableUsd) : e.borrowableUsd)
  const byExposure = exposures.map((e, i) => ({ id: e.id, upsideUsd: 0, downsideUsd: downsideEv(e, ratios[i], liq), r: ratios[i] }))
  const keys = new Map<string, number[]>()
  exposures.forEach((e, i) => {
    if (ratios[i] > 1) keys.set(e.liquidityKey, [...(keys.get(e.liquidityKey) ?? []), i])
  })
  for (const idx of keys.values()) {
    let remaining = Math.max(...idx.map((i) => borrowableOf(exposures[i])))
    const terms = idx
      .map((i) => ({ i, t: upsideTerms(exposures[i], ratios[i], liq) }))
      .filter((x): x is { i: number; t: { k: number; maxBorrow: number } } => x.t !== null)
      .sort((a, b) => b.t.k - a.t.k)
    for (const { i, t } of terms) {
      if (remaining <= 0) break
      const b = Math.min(remaining, t.maxBorrow)
      byExposure[i].upsideUsd = b * (1 - 1 / t.k)
      remaining -= b
    }
  }
  const upsideUsd = byExposure.reduce((a, x) => a + x.upsideUsd, 0)
  const downsideUsd = byExposure.reduce((a, x) => a + x.downsideUsd, 0)
  return { totalUsd: upsideUsd + downsideUsd, upsideUsd, downsideUsd, byExposure }
}

/** Morpho Blue liquidation incentive factor: min(1.15, 1 / (0.3·LLTV + 0.7)). */
export const morphoLif = (lltv: number): number => Math.min(1.15, 1 / (0.3 * lltv + 0.7))
