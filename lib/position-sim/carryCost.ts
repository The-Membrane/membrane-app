/**
 * WHAT THE CARRY COSTS TODAY, AND WHAT IT COSTS ON MEMBRANE.
 *
 * The landing page leads with cost, not with the liquidation story (owner ruling
 * 2026-09-11: "if our initial product sale is the carry product, the landing page must
 * be carry-first"). This module is the whole arithmetic behind that headline, and it is
 * deliberately narrow.
 *
 * THE MODEL it encodes — owner ruling, repeated "a million times": MEMBRANE DOES NOT
 * CHARGE 0%. Membrane charges THROUGH THE DEPLOYMENT VENUES. Debt deployed into a
 * canonical venue carries no interest; the protocol's revenue is a curator-set share of
 * that venue's yield (the user/protocol/manager split), so the borrower's cost tracks what
 * the venue actually pays. The spread CAN invert in a worst case; curators cover it first
 * through required bonds and the borrower is last in line (owner correction Sep 2026:
 * never claim an absolute 'can't invert'). On Aave the borrow rate is charged whether
 * the venue pays or not.
 *
 * THE NUMBER WE REFUSE TO PRINT: the share is curator-set and not fixed pre-launch, so
 * this module never prices Membrane's side. What it prices is the FIXED charge the
 * position pays today on the deployed slice (`fixedCostOnCoveredUsd`) — the amount that
 * on Membrane would be paid out of yield instead of out of pocket. Undeployed debt is
 * reported as a quantity, never as a cost.
 *
 * THE DOUBLE-COUNT WE REFUSE: a detected balance that is ALREADY this position's
 * collateral is not deployed debt. An Aave aToken balance IS the holder's Aave supply,
 * so a borrower on Aave who supplied USDC shows up in the venue scan holding aEthUSDC —
 * the same dollars, on both sides of the balance sheet. Crediting those as "debt
 * working in a venue" would invent a carry out of collateral. Any detected venue whose
 * `underlying` (or own symbol) appears as a collateral leg of THIS position is dropped
 * from `deployedUsd` and reported separately as `collateralDeployedUsd`.
 * Measured 2026-09-11: the first real wallet the snapshot script picked had exactly
 * this shape — $295,609 of USDC collateral and $295,645 of "detected" aEthUSDC.
 *
 * THE OTHER REFUSAL: legs whose adapter did not expose a borrow APR contribute nothing.
 * They are summed into `unpricedDebtUsd` so the surface can say "we could not read the
 * rate on $X" instead of inventing one. Morpho Blue is the live example — its adapter
 * returns `borrowApr: null` (adapters/morphoBlue.ts), so a Morpho-only position yields
 * no cost line and the hero falls back to the safety verdict.
 */

import type { ProtocolPosition } from './types'
import { excludeOwnCollateral } from './venues'
import type { VenueDetection } from './venues'

export interface CarryCost {
  /** Σ (leg.valueUsd × leg.borrowApr) over debt legs that expose an APR. */
  annualCostUsd: number
  /** Debt whose rate we actually read. */
  pricedDebtUsd: number
  /** Debt whose rate the adapter did not expose. Never costed. */
  unpricedDebtUsd: number
  /** USD detected in canonical venues that is NOT this position's own collateral. */
  deployedUsd: number
  /** Detected USD dropped because it is already a collateral leg of this position. */
  collateralDeployedUsd: number
  /** The deployed slice: min(deployed, priced debt). On Membrane this slice carries no
   *  interest — it is charged through the venue's yield instead. */
  coveredDebtUsd: number
  /** coveredDebtUsd × aprWeighted — the FIXED interest that slice pays today, charged
   *  whether the venue yields or not. On Membrane it would come out of yield. */
  fixedCostOnCoveredUsd: number
  /** Value-weighted borrow APR across the priced legs. 0 when nothing is priced. */
  aprWeighted: number
}

const EMPTY: CarryCost = {
  annualCostUsd: 0,
  pricedDebtUsd: 0,
  unpricedDebtUsd: 0,
  deployedUsd: 0,
  collateralDeployedUsd: 0,
  coveredDebtUsd: 0,
  fixedCostOnCoveredUsd: 0,
  aprWeighted: 0,
}

export function carryCost(
  position: ProtocolPosition | null | undefined,
  detection: VenueDetection | null | undefined,
): CarryCost {
  if (!position) return EMPTY

  let annualCostUsd = 0
  let pricedDebtUsd = 0
  let unpricedDebtUsd = 0

  for (const leg of position.debt) {
    const value = leg.valueUsd
    if (!Number.isFinite(value) || value <= 0) continue
    if (leg.borrowApr === null || !Number.isFinite(leg.borrowApr)) {
      unpricedDebtUsd += value
      continue
    }
    pricedDebtUsd += value
    annualCostUsd += value * leg.borrowApr
  }

  // A detected venue whose underlying is one of this position's collateral legs is the
  // same money seen twice — see the header. One filter, shared with the recall path.
  const detectedTotal = detection && detection.status === 'detected' ? detection.totalUsd : 0
  const real = detection ? excludeOwnCollateral(detection, position) : null
  const deployedUsd = real && real.status === 'detected' ? real.totalUsd : 0
  const collateralDeployedUsd = Math.max(0, detectedTotal - deployedUsd)
  const coveredDebtUsd = Math.min(deployedUsd, pricedDebtUsd)
  const aprWeighted = pricedDebtUsd > 0 ? annualCostUsd / pricedDebtUsd : 0

  return {
    annualCostUsd,
    pricedDebtUsd,
    unpricedDebtUsd,
    deployedUsd,
    collateralDeployedUsd,
    coveredDebtUsd,
    fixedCostOnCoveredUsd: coveredDebtUsd * aprWeighted,
    aprWeighted,
  }
}
