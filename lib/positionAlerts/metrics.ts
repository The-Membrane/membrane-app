/**
 * Position metrics the rules read: LTV, health factor, liquidation price, and the repay /
 * top-up that would restore a target health factor. Pure arithmetic over one snapshot.
 *
 * Health factor uses the VENUE's oracle prices, because that is what liquidates.
 * `marketHealthFactor` re-values the same legs at market price — it differs only where a
 * venue prices an asset by exchange rate or a hard-coded value.
 */

import type { PositionSnapshot } from './types'

export interface DominantLeg {
  symbol: string
  /** Share of collateral value (oracle prices), 0–1. */
  share: number
  priceUsd: number
  /**
   * Oracle price of this asset at which health factor hits 1 with every other leg held
   * at its current price. null when the other legs alone cover the debt.
   */
  liquidationPriceUsd: number | null
  /** 1 − liquidationPrice / price. Fraction of price the asset can lose. null as above. */
  distance: number | null
}

export interface PositionMetrics {
  collateralUsd: number
  debtUsd: number
  /** debt / collateral, 0 when there is no collateral and no debt. */
  ltv: number
  /** Collateral-value-weighted liquidation threshold — the LTV at which the position dies. */
  liquidationLtv: number
  /** Σ amount × oraclePrice × LT / debt. Infinity with no debt. */
  healthFactor: number
  /** Same, valued at market prices. */
  marketHealthFactor: number
  dominant: DominantLeg | null
}

const marketPrice = (c: { oraclePriceUsd: number; marketPriceUsd?: number }) =>
  c.marketPriceUsd ?? c.oraclePriceUsd

export function computeMetrics(s: PositionSnapshot): PositionMetrics {
  let collateralUsd = 0
  let weighted = 0
  let weightedMarket = 0
  for (const c of s.collateral) {
    const v = c.amount * c.oraclePriceUsd
    collateralUsd += v
    weighted += v * c.liquidationThreshold
    weightedMarket += c.amount * marketPrice(c) * c.liquidationThreshold
  }
  const debtUsd = s.debt.reduce((a, d) => a + d.amount * d.priceUsd, 0)
  const ltv = collateralUsd > 0 ? debtUsd / collateralUsd : debtUsd > 0 ? Infinity : 0
  const liquidationLtv = collateralUsd > 0 ? weighted / collateralUsd : 0
  const healthFactor = debtUsd > 0 ? weighted / debtUsd : Infinity
  const marketHealthFactor = debtUsd > 0 ? weightedMarket / debtUsd : Infinity

  let dominant: DominantLeg | null = null
  let best = -1
  for (const c of s.collateral) {
    const v = c.amount * c.oraclePriceUsd
    if (v <= best || c.amount <= 0) continue
    best = v
    const others = weighted - v * c.liquidationThreshold
    const need = debtUsd - others
    const liq =
      need > 0 && c.liquidationThreshold > 0 ? need / (c.amount * c.liquidationThreshold) : null
    dominant = {
      symbol: c.symbol,
      share: collateralUsd > 0 ? v / collateralUsd : 0,
      priceUsd: c.oraclePriceUsd,
      liquidationPriceUsd: liq,
      distance: liq === null ? null : 1 - liq / c.oraclePriceUsd,
    }
  }
  return { collateralUsd, debtUsd, ltv, liquidationLtv, healthFactor, marketHealthFactor, dominant }
}

/**
 * USD of debt to repay so health factor reaches `targetHf`. 0 when already there.
 * Repaying debt D' = weightedCollateral / targetHf.
 */
export function repayToReach(m: PositionMetrics, targetHf: number): number {
  if (!(targetHf > 0) || !Number.isFinite(m.healthFactor)) return 0
  const weighted = m.healthFactor * m.debtUsd
  return Math.max(0, m.debtUsd - weighted / targetHf)
}

/**
 * USD of collateral (at liquidation threshold `lt`) to add so health factor reaches
 * `targetHf`. 0 when already there.
 */
export function topUpToReach(m: PositionMetrics, targetHf: number, lt: number): number {
  if (!(targetHf > 0) || !(lt > 0) || !Number.isFinite(m.healthFactor)) return 0
  const weighted = m.healthFactor * m.debtUsd
  return Math.max(0, (targetHf * m.debtUsd - weighted) / lt)
}

/**
 * Debt a position must repay — from deployed capital it would recall — to hold
 * `targetHf` after every market-priced collateral leg loses `shock` (0–1) of its value.
 * This is the recall the position would NEED in that move.
 */
export function recallNeededUsd(s: PositionSnapshot, shock: number, targetHf: number): number {
  let weighted = 0
  for (const c of s.collateral) {
    const moves = (c.oracleBasis ?? 'market') === 'market'
    weighted += c.amount * c.oraclePriceUsd * (moves ? 1 - shock : 1) * c.liquidationThreshold
  }
  const debtUsd = s.debt.reduce((a, d) => a + d.amount * d.priceUsd, 0)
  if (!(targetHf > 0)) return 0
  return Math.max(0, debtUsd - weighted / targetHf)
}
