/**
 * Cost of a move, from an impact curve and a holding regime.
 *
 * An impact curve says, for a log displacement x of the leaf spot, how much notional
 * Q must trade and how much premium J (paid over fair value) the push costs. On an AMM
 * the attacker gets J back by trading back down the same curve. So the cost depends on
 * who trades in between:
 *
 *  - atomic (hold 0, spot readers only): push, use the price, unwind in one tx.
 *    Cost = fees both ways = 2·fee·Q. Flash loans are free (Morpho, Balancer).
 *  - passive (no one reverts the displacement while it is held): push, hold, unwind.
 *    Cost = 2·fee·Q. This is the PT-reUSD case: the spot stayed down for ~14 min.
 *  - competitive (an arbitrageur reverts it every block): the attacker re-pushes each
 *    block and the arbitrageur keeps the premium. Cost = 2·fee·Q + n·(J + fee·Q),
 *    n = ceil(hold / 12 s). This needs the attacker to end each block displaced
 *    (builder priority); the bribe for that is NOT included.
 *
 * A donation (ERC-4626 share rate) is permanent and costs J = Q in every regime.
 */

import type { Direction, ImpactCurve, ImpactSample, Regime } from '../types'

export const BLOCK_SEC = 12

/** Percent moves the curves are sampled at (both directions; down is capped at -90%). */
export const MOVE_GRID_PCT = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 30, 50, 75, 100, 200] as const

export const pctToX = (pct: number, dir: Direction): number => {
  const f = dir === 'up' ? 1 + pct / 100 : 1 - Math.min(pct, 90) / 100
  return Math.abs(Math.log(f))
}
export const xToPct = (x: number, dir: Direction): number => (dir === 'up' ? Math.expm1(x) : -Math.expm1(-x)) * 100

/** Log grid for one direction (duplicates from the -90% cap removed). */
export function xGrid(dir: Direction): number[] {
  return [...new Set(MOVE_GRID_PCT.map((p) => pctToX(p, dir)))]
}

/** Linear interpolation of Q and J at x; null if x is past the curve's reach. */
export function sampleAt(curve: ImpactCurve, x: number): { qUsd: number; jUsd: number } | null {
  if (x <= 0) return { qUsd: 0, jUsd: 0 }
  if (x > curve.maxX * (1 + 1e-9)) return null
  const s = curve.samples
  if (s.length === 0) return null
  let lo: ImpactSample = { x: 0, qUsd: 0, jUsd: 0 }
  for (const p of s) {
    if (p.x >= x) {
      const t = p.x === lo.x ? 1 : (x - lo.x) / (p.x - lo.x)
      return { qUsd: lo.qUsd + t * (p.qUsd - lo.qUsd), jUsd: lo.jUsd + t * (p.jUsd - lo.jUsd) }
    }
    lo = p
  }
  // Between the last sample and maxX: the curve is flat (no liquidity left to cross).
  return { qUsd: lo.qUsd, jUsd: lo.jUsd }
}

export function holdBlocks(holdSec: number): number {
  return holdSec <= 0 ? 0 : Math.ceil(holdSec / BLOCK_SEC)
}

/** Net USD cost of displacing by x and holding for holdSec under a regime. */
export function strategyCost(curve: ImpactCurve, x: number, holdSec: number, regime: Regime): number | null {
  const s = sampleAt(curve, x)
  if (!s) return null
  if (curve.mechanism === 'donation') return s.jUsd
  const roundTripFees = 2 * curve.feeRate * s.qUsd
  if (regime === 'atomic') return holdSec > 0 ? null : roundTripFees
  if (regime === 'passive') return roundTripFees
  const n = holdBlocks(holdSec)
  return roundTripFees + n * (s.jUsd + curve.feeRate * s.qUsd)
}

/**
 * Build samples on the standard grid from a monotone "walk" function that returns the
 * cumulative (Q, J) at each requested x (ascending), or stops early at its reach.
 */
export function curveFromWalk(
  direction: Direction,
  feeRate: number,
  walk: (targets: number[]) => { samples: ImpactSample[]; maxX: number },
  extra: Partial<ImpactCurve> = {},
): ImpactCurve {
  const { samples, maxX } = walk(xGrid(direction))
  return {
    direction,
    feeRate,
    samples,
    maxX,
    mechanism: 'trade',
    liquidity: 'full',
    ...extra,
  }
}
