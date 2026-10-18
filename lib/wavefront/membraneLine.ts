/**
 * MEMBRANE'S OWN LINE for a wavefront position (owner ruling 2026-10-18: the census headline
 * walks every position at Membrane's per-asset line, not the protocol's).
 *
 * It is the per-wallet simulator's rule, run on the census's t0 legs, through the SAME helpers
 * (lib/position-sim/membrane.ts, collateralClass.ts), so a pasted address and its census row
 * cannot disagree on the line:
 *
 *   whole line  weightedMembraneLine(every collateral leg at its t0 value).maxLtv — the
 *               value-weighted Membrane max LTV at t0 (compare.ts runMembrane). Per asset:
 *               MEMBRANE_ASSET_LTV (modelled, WETH 0.80, …) and DEPLOY_LAUNCH_LTV (the deploy
 *               script's own sUSDS 0.88 / syrupUSDC 0.86 / scrvUSD 0.86), each clamped to its
 *               class's hard cap (membraneMaxLtv).
 *   class       delayClassOf(every collateral symbol, whole line) — stable => no-delay listing
 *               (collateralClass.ts), and any line above 90% is no-delay.
 *   mixed       split exactly like compare.ts splitByDelayClass: the no-delay legs (sub 0) and
 *               the delayed legs (sub 1), debt pro rata to collateral value at t0; each half at
 *               membraneHalfLine (its own weighted line, or the whole line when none of its legs
 *               has one), clamped to its class cap; its class delayClassOf(its symbols, its line).
 *
 * MISSING LINE (the explicit rule, counted by the census):
 *   - NO leg has a Membrane line (AAVE, tETH, LBTC, … alone): there is no line to walk at.
 *     `membraneLinePlan` returns null and the census EXCLUDES the position from the headline on
 *     both sides ('no-membrane-line'), reporting the count and the dollars. Nothing is invented.
 *   - SOME legs have no line: the simulator's rule — those legs are left out of the weighted line
 *     (weightedMembraneLine `unknown`), so the line is the known legs' value-weighted line, and
 *     their value still counts as collateral. Counted (positions, unknown share). The strict
 *     alternative (exclude these too) is a published sensitivity.
 */

import { delayClassOf, isNoDelayCollateral } from '../position-sim/collateralClass'
import { membraneHalfLine, weightedMembraneLine } from '../position-sim/membrane'
import { sumValue, type HalfSpec, type SpecLeg } from './aave'
import type { DelayClass } from './stream'

export interface MembraneLinePlan {
  /** The whole position's value-weighted Membrane line at t0 (legs with no line left out). */
  line: number
  /** Collateral symbols with no Membrane line, left out of the weighted line (sorted, unique). */
  unknown: string[]
  /** Share of the t0 collateral value on legs with no Membrane line. */
  unknownShare: number
  delayClass: DelayClass
  /** One half, or two for a mixed position (sub 0 no-delay legs, sub 1 delayed legs). */
  halves: HalfSpec[]
  /** Subs whose half has no leg with a line and runs at the whole position's line. */
  lineFromWhole: number[]
}

const lineLegs = (legs: readonly SpecLeg[]) =>
  legs.map((l) => ({ symbol: l.symbol, valueUsd: l.value0 }))

/** Membrane's line plan for a position's t0 collateral, or null when no leg has a line. */
export function membraneLinePlan(collateral: readonly SpecLeg[]): MembraneLinePlan | null {
  const w = weightedMembraneLine(lineLegs(collateral))
  if (!(w.maxLtv > 0)) return null
  const line = w.maxLtv
  const symbols = collateral.map((l) => l.symbol)
  const unknownSet = new Set(w.unknown)
  const total = sumValue(collateral)
  const unknownValue = collateral
    .filter((l) => unknownSet.has(l.symbol))
    .reduce((a, l) => a + l.value0, 0)
  const delayClass = delayClassOf(symbols, line)
  const plan: MembraneLinePlan = {
    line,
    unknown: [...unknownSet].sort(),
    unknownShare: total > 0 ? unknownValue / total : 0,
    delayClass,
    halves: [],
    lineFromWhole: [],
  }
  if (delayClass !== 'mixed') {
    plan.halves = [{ collateral: [...collateral], share: 1, line, delayClass }]
    return plan
  }
  const parts = [
    collateral.filter((l) => isNoDelayCollateral(l.symbol)),
    collateral.filter((l) => !isNoDelayCollateral(l.symbol)),
  ]
  plan.halves = parts.map((legs, k): HalfSpec => {
    const h = membraneHalfLine(lineLegs(legs), k === 0, line)
    if (h.lineFromWhole) plan.lineFromWhole.push(k)
    const c = delayClassOf(
      legs.map((l) => l.symbol),
      h.line,
    )
    return {
      sub: k,
      collateral: legs,
      share: total > 0 ? sumValue(legs) / total : 0.5,
      line: h.line,
      delayClass: c === 'mixed' ? 'delayed' : c,
    }
  })
  return plan
}
