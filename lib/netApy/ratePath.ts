/**
 * THE IRM-PROJECTED RATE PATH — the hand-off to Risk Frontier.
 *
 * Risk Frontier (lib/position-sim/stressGrid.ts, branch feat/risk-frontier-stress-grid
 * @ 44c79c8b) can add a rate-spike axis by calling `rateSpikeAxis(snapshot, …)`. That
 * engine is deliberately NOT touched here; this module only exposes the data.
 *
 * WHAT A PATH IS: utilization is pinned at a level (the user's post-size utilization,
 * or a stress level such as the kink or 100%) and held there; the borrow and supply
 * rates are read along time. Static curves (Aave, Spark, Euler) give a flat line at
 * the level's rate. Morpho's AdaptiveCurveIrm does not: away from 90% its
 * rateAtTarget compounds at 50/yr x error, so at 100% the rate doubles every ~5.1 days
 * until the 200%/yr ceiling. Holding utilization fixed is the stated assumption — in a
 * real spike borrowers repay and suppliers arrive, which pulls utilization back.
 * Every point is a projection (label class 'projected'), not a forecast, and the axis
 * as a whole is the umbrella's claim class 'stress-scenario': deterministic, stated
 * assumptions, "not a probability".
 */

import { WAD } from './fixedPoint'
import { kinkUtilization, ratesAtSize, ratesAtUtilization } from './irm'
import type {
  BlockAnchor,
  ClaimClass,
  LabelClass,
  RatePathPoint,
  SizeDelta,
  VenueSnapshot,
} from './types'

export const DAY_S = 86_400

const toWad = (u: number): bigint => {
  if (!Number.isFinite(u) || u < 0 || u > 1) throw new Error('utilization must be within [0, 1]')
  // 1e-12 resolution is far below any rate effect and keeps the float out of the math.
  return (BigInt(Math.round(u * 1e12)) * WAD) / 10n ** 12n
}

export interface RatePathRequest {
  /** Utilization to hold, 0–1. Omit and pass `size` to hold the post-size level. */
  utilization?: number
  size?: SizeDelta
  horizonSeconds: number
  /** Number of intervals; the path has steps + 1 points, t = 0 … horizon. */
  steps: number
}

export function ratePath(s: VenueSnapshot, req: RatePathRequest): RatePathPoint[] {
  if (!(req.horizonSeconds > 0) || !Number.isInteger(req.steps) || req.steps < 1) {
    throw new Error('ratePath: horizonSeconds > 0 and an integer steps >= 1 are required')
  }
  const u =
    req.utilization !== undefined
      ? toWad(req.utilization)
      : req.size
        ? ratesAtSize(s, req.size).wad.utilization
        : ratesAtSize(s, { supply: 0n, borrow: 0n }).wad.utilization
  const out: RatePathPoint[] = []
  for (let i = 0; i <= req.steps; i++) {
    const t = Math.round((req.horizonSeconds * i) / req.steps)
    const p = ratesAtUtilization(s, u, BigInt(t))
    out.push({ t, utilization: p.utilization, borrowApr: p.borrowApr, supplyApr: p.supplyApr })
  }
  return out
}

export interface RateSpikeLevel {
  /** What the level is: the venue now, the user's post-size level, the kink, a stress. */
  name: 'now' | 'at-size' | 'kink' | 'stress'
  utilization: number
  borrowAprNow: number
  borrowAprAtHorizon: number
  /** Highest borrow APR on the path (equal to AtHorizon for monotone paths). */
  borrowAprMax: number
  supplyAprNow: number
  path: RatePathPoint[]
}

export interface RateSpikeAxis {
  venueKey: string
  anchor: BlockAnchor
  label: LabelClass
  claim: Extract<ClaimClass, 'stress-scenario'>
  horizonSeconds: number
  levels: RateSpikeLevel[]
  assumption: string
}

export const RATE_PATH_ASSUMPTION =
  'Utilization held fixed at each level for the whole horizon. Projection from on-chain IRM parameters at the anchor block; not a forecast.'

/**
 * The axis: one path per level. Default levels are the venue now, the kink, 95% and
 * 100% utilization; pass `size` to add the user's post-size level.
 */
export function rateSpikeAxis(
  s: VenueSnapshot,
  opts: { size?: SizeDelta; stressUtilizations?: number[]; horizonSeconds?: number; steps?: number } = {},
): RateSpikeAxis {
  const horizonSeconds = opts.horizonSeconds ?? 30 * DAY_S
  const steps = opts.steps ?? 30
  const nowU = ratesAtSize(s, { supply: 0n, borrow: 0n }).utilization
  const kinkU = Number(kinkUtilization(s)) / 1e18
  const levels: { name: RateSpikeLevel['name']; u: number }[] = [
    { name: 'now', u: nowU },
    ...(opts.size ? [{ name: 'at-size' as const, u: ratesAtSize(s, opts.size).utilization }] : []),
    { name: 'kink', u: kinkU },
    ...(opts.stressUtilizations ?? [0.95, 1]).map((u) => ({ name: 'stress' as const, u })),
  ]
  return {
    venueKey: s.venueKey,
    anchor: s.anchor,
    label: 'projected',
    claim: 'stress-scenario',
    horizonSeconds,
    assumption: RATE_PATH_ASSUMPTION,
    levels: levels.map(({ name, u }) => {
      const path = ratePath(s, { utilization: Math.min(1, Math.max(0, u)), horizonSeconds, steps })
      return {
        name,
        utilization: path[0].utilization,
        borrowAprNow: path[0].borrowApr,
        borrowAprAtHorizon: path[path.length - 1].borrowApr,
        borrowAprMax: Math.max(...path.map((p) => p.borrowApr)),
        supplyAprNow: path[0].supplyApr,
        path,
      }
    }),
  }
}
