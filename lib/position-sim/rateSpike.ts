/**
 * rateSpike — the adapter from net-APY-at-size's rate-spike axis to the stress engine's
 * rate dimension. ENGINE ONLY, one-way: `rateSpikeAxis()` (lib/netApy/ratePath.ts, PR #92
 * on evm-migration) projects each level's borrow and supply APR from the venue's on-chain
 * irm_params; this turns each level into a stressGrid `RateShape`. The engine never reads a
 * venue snapshot, and lib/netApy is not touched.
 *
 * WHAT IT TAKES. A `RateSpikeAxis` exactly as `rateSpikeAxis()` returns it, read
 * structurally (`RateSpikeAxisInput` lists only the fields used here). So this branch builds
 * without lib/netApy, and the real type is assignable once both sit on one branch.
 *
 * WHAT IT GIVES. One 'path' shape per axis level, carrying the level's borrow APR (what the
 * debt accrues) and supply APR (what recalled capital gives up). The id names the venue,
 * the anchor block, the level and its utilization, e.g.
 * 'morpho-blue-cbbtc-usdc-86@26120000:stress-u100', so a cell key and a scenario id say
 * where the path comes from.
 *
 * WHAT IT CLAIMS. The axis's own claim class: a stress scenario with utilization held fixed
 * for the whole horizon (`assumption`, RATE_PATH_ASSUMPTION). In a real spike borrowers
 * repay and suppliers arrive, which pulls utilization back. Not a forecast.
 */

import type { RateShape, RateStress } from './stressGrid'

/** One projected point (lib/netApy/types.ts `RatePathPoint`, the fields used here). */
export interface RateSpikePointInput {
  t: number
  borrowApr: number
  supplyApr: number
}

/** One axis level (lib/netApy/ratePath.ts `RateSpikeLevel`, the fields used here). */
export interface RateSpikeLevelInput {
  name: 'now' | 'at-size' | 'kink' | 'stress'
  utilization: number
  path: readonly RateSpikePointInput[]
}

/** lib/netApy/ratePath.ts `RateSpikeAxis`, the fields used here. */
export interface RateSpikeAxisInput {
  venueKey: string
  anchor: { blockNumber: bigint }
  claim: 'stress-scenario'
  horizonSeconds: number
  assumption: string
  levels: readonly RateSpikeLevelInput[]
}

export type RatePathShape = Extract<RateShape, { kind: 'path' }>

export interface RateSpikeShape {
  venueKey: string
  level: RateSpikeLevelInput['name']
  /** The utilization the level holds, 0–1. */
  utilization: number
  shape: RatePathShape
  /** The axis's stated assumption. Show it wherever the shape's result is shown. */
  assumption: string
}

/** Utilization as a percent id: 0.9383077914 → '93.83', 1 → '100'. */
const utilizationId = (u: number) => String(Math.round(u * 1e4) / 1e2)

/** The shape id of one level: '<venueKey>@<block>:<level>-u<utilization %>'. */
export function rateSpikeShapeId(axis: RateSpikeAxisInput, level: RateSpikeLevelInput): string {
  return `${axis.venueKey}@${axis.anchor.blockNumber}:${level.name}-u${utilizationId(level.utilization)}`
}

/** One path shape per axis level, in the axis's level order. */
export function rateSpikeShapes(axis: RateSpikeAxisInput): RateSpikeShape[] {
  return axis.levels.map((level) => ({
    venueKey: axis.venueKey,
    level: level.name,
    utilization: level.utilization,
    assumption: axis.assumption,
    shape: {
      kind: 'path',
      id: rateSpikeShapeId(axis, level),
      points: level.path.map((p) => ({ t: p.t, borrowApr: p.borrowApr, supplyApr: p.supplyApr })),
    },
  }))
}

/**
 * One rate stress per axis level, each lasting `hours` (default: the axis's whole horizon).
 * Pass them as `StressGridOptions.rates` for the grid's rate rows.
 */
export function rateSpikeStresses(
  axis: RateSpikeAxisInput,
  hours: number = axis.horizonSeconds / 3600,
): RateStress[] {
  return rateSpikeShapes(axis).map((s) => ({ shape: s.shape, hours }))
}
