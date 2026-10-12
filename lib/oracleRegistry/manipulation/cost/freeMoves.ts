/**
 * Zero-cost moves: price differences an attacker gets without trading.
 *
 *  - deviation band: a push feed only updates past its deviation threshold, so its
 *    answer can sit up to the threshold away from the market (either side).
 *  - clamp: a feed or adapter bound (Chainlink min/maxAnswer, CAPO growth cap). Free
 *    only while the market is past the bound. Otherwise it is headroom, reported only.
 *  - pull selection: a pull oracle (Pyth, RedStone core) takes any signed price inside
 *    its staleness window. The caller picks the best one, worth about z·σ·√(window).
 *  - divergence: a fixed or model price (hard-coded $1, linear PT discount) against
 *    the asset's own market price, measured now.
 * Read-only reentrancy is not a move with a size. It is a hard-red override, see
 * `hardRedReasons` in ../ratio.ts.
 */

import type { Direction, FreeMove } from '../types'
import { YEAR_SEC } from './pendle'

const BOTH: Direction[] = ['up', 'down']

export function deviationBand(thresholdPct: number, label: string): FreeMove | null {
  if (!(thresholdPct > 0)) return null
  return {
    kind: 'deviation-band',
    x: Math.log(1 + thresholdPct / 100),
    directions: BOTH,
    note: `${label}: push feed deviation threshold ${thresholdPct}%`,
  }
}

/**
 * A clamp is free only when the current answer sits on the bound (the market may be
 * anywhere past it). Then the move size is unknown and `assumedPct` is used.
 */
export function clampMove(
  answer: number,
  min: number | null,
  max: number | null,
  label: string,
  assumedPct = 10,
): { move: FreeMove | null; headroomPct: { down: number | null; up: number | null } } {
  const headroomPct = {
    down: min !== null && min > 0 ? (1 - min / answer) * 100 : null,
    up: max !== null && max > 0 ? (max / answer - 1) * 100 : null,
  }
  const atMin = min !== null && answer <= min * 1.000001
  const atMax = max !== null && answer >= max * 0.999999
  if (!atMin && !atMax) return { move: null, headroomPct }
  return {
    headroomPct,
    move: {
      kind: 'clamp',
      x: Math.log(1 + assumedPct / 100),
      // Pinned at the floor: the oracle overvalues the asset (borrow-and-walk side).
      directions: atMin ? ['up'] : ['down'],
      note: `${label}: answer is pinned at its ${atMin ? 'minAnswer' : 'maxAnswer'}; market gap unknown, ${assumedPct}% assumed`,
    },
  }
}

/** Annualized volatility defaults by asset class, used only when none is given. */
export const DEFAULT_VOL: Record<string, number> = {
  stable: 0.03,
  lst: 0.08,
  major: 0.6,
  alt: 1.0,
}

export function pullSelection(maxStalenessSec: number, annualVol: number, label: string, z = 3): FreeMove | null {
  if (!(maxStalenessSec > 0) || !(annualVol > 0)) return null
  const x = z * annualVol * Math.sqrt(maxStalenessSec / YEAR_SEC)
  return {
    kind: 'pull-selection',
    x,
    directions: BOTH,
    note: `${label}: caller-chosen price within ${maxStalenessSec}s staleness, ${z}σ at ${(annualVol * 100).toFixed(0)}%/yr`,
  }
}

/** Oracle vs market now. Oracle above market → the 'up' side (overvalued collateral). */
export function divergence(oraclePrice: number, marketPrice: number, label: string, minPct = 0.05): FreeMove | null {
  if (!(oraclePrice > 0) || !(marketPrice > 0)) return null
  const x = Math.abs(Math.log(oraclePrice / marketPrice))
  if (x * 100 < minPct) return null
  return {
    kind: 'divergence',
    x,
    directions: [oraclePrice > marketPrice ? 'up' : 'down'],
    note: `${label}: oracle ${oraclePrice.toPrecision(6)} vs market ${marketPrice.toPrecision(6)}`,
  }
}
