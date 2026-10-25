/**
 * ONE REPLAY, BROWSER OR SERVER. The landing's chart and the share card's server route
 * both call this, so the card can never print a figure the page would not.
 *
 * The run is the simulator's own (lib/position-sim runComparison) at the simulator's own
 * defaults: Membrane line = the modelled value-weighted line, liquidation fee 0 (the
 * deployed LIQ_FEE), the venue repay size measured from Oct 10, and venue recall only
 * from what the venue scan detected for THIS address, net of its own collateral.
 */

import {
  buildPricePath,
  excludeOwnCollateral,
  measuredRepayFraction,
  runComparison,
  toVenueRecall,
  weightedMembraneLine,
  type Comparison,
  type Oct10Manifest,
  type Oct10Series,
  type ProtocolPosition,
  type VenueDetection,
} from '@/lib/position-sim'

export interface MeasuredLiquidations {
  aaveV3?: { medianRepayFraction?: number; events?: number }
  morphoBlue?: { medianRepayFraction?: number; events?: number }
}

export interface ReplayInputs {
  series: Oct10Series
  manifest: Oct10Manifest
  measured: MeasuredLiquidations | null
}

export function runReplay(
  position: ProtocolPosition,
  detection: VenueDetection | null,
  inputs: ReplayInputs,
): Comparison {
  const symbols = [...position.collateral.map((c) => c.symbol), ...position.debt.map((d) => d.symbol)]
  const { path, unpriced } = buildPricePath(inputs.series, inputs.manifest, symbols)
  const repay = measuredRepayFraction(position.protocol, inputs.measured)
  const venue = detection ? toVenueRecall(excludeOwnCollateral(detection, position)) : null
  const m = inputs.manifest
  return runComparison(position, path, unpriced, {
    membraneMaxLtv: weightedMembraneLine(position.collateral).maxLtv,
    membraneLiqFee: 0,
    venue,
    sourceRepayFraction: repay.fraction,
    sourceRepayFractionLabel: repay.label,
    scenarioLabel: `${m.name} · ${m.resolution} oracle candles, ${m.windowStartUtc.slice(0, 10)} to ${m.windowEndUtc.slice(0, 10)}`,
  })
}

/** The largest loan — the one whose liquidation matters. */
export function largestPosition(positions: ProtocolPosition[]): ProtocolPosition | null {
  if (positions.length === 0) return null
  return positions.reduce((a, b) => (b.totalDebtUsd > a.totalDebtUsd ? b : a))
}

export const positionKey = (p: ProtocolPosition) => `${p.protocol}:${p.marketId ?? ''}`
