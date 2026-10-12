/**
 * The ratio stage: join cost, EV and free moves into R_lo / R_pt curves and a verdict.
 *
 * For a move of the leaf spot by log x in a direction, held for h seconds:
 *   - each exposure's price tree is re-evaluated with the leaf's read seeing
 *     readMove(read, x, h), giving a collateral/debt ratio factor r_i;
 *   - EV_hi and EV_pt come from ev/math.totalEv over all exposures;
 *   - C_lo is the cheapest passive cost (full or top-k-LP-removed liquidity), C_pt the
 *     passive full-liquidity cost. Both are regime 'passive' because every measured
 *     attack (PT-reUSD included) held the move unopposed; the competitive cost is kept
 *     only as context.
 *   - R_lo = C_lo / EV_hi, R_pt = C_pt / EV_pt.
 * The attacker minimises the ratio over x, direction and hold, so the verdict reads the
 * MINIMUM R_lo and R_pt over the grid. Owner rulings 2026-10-05:
 *   RED    if R_lo < 1.5, or a hard-red override, or free-move EV ≥ $100k
 *   YELLOW if R_pt < 10, or C_lo at the worst point < $100M, or any free-move EV > 0
 *   GREEN  otherwise.
 * Every measured past attack had cost/extracted ≤ 0.76; the card states this.
 */

import type {CurvePoint, Direction, Exposure, FreeMove, ImpactCurve, PriceNode, Verdict} from './types'
import { readMove, treeFactor } from './tree'
import { totalEv, type EvBreakdown } from './ev/math'
import { strategyCost } from './cost/impact'

export const RULINGS = {
  rLoRed: 1.5,
  rPtYellow: 10,
  cLoFloorUsd: 100e6,
  freeMoveRedUsd: 100e3,
  pastAttackMaxRatio: 0.76,
} as const

export interface CostCurves {
  full: Partial<Record<Direction, ImpactCurve>>
  topKRemoved?: Partial<Record<Direction, ImpactCurve>>
}

export interface RatioInput {
  leafId: string
  exposures: Exposure[]
  cost: CostCurves
  freeMoves: FreeMove[]
  hardRed?: { reason: string } | null
  /** Hold times to try, seconds. 0 (atomic) and each TWAP/EMA window are added. */
  extraHolds?: number[]
}

export interface Strategy {
  direction: Direction
  x: number
  holdSec: number
}

export interface RatioResult {
  leafId: string
  verdict: Verdict
  reasons: string[]
  rLo: number | null
  rPt: number | null
  cLoAtWorstUsd: number | null
  freeMoveEvUsd: number
  freeMoveEvHiUsd: number
  best: { lo: (Strategy & { cUsd: number; evUsd: number }) | null; pt: (Strategy & { cUsd: number; evUsd: number }) | null }
  curve: CurvePoint[]
  competitiveCostNote?: string
}

/**
 * Factor r_i on each exposure's collateral/debt price ratio when the leaf spot is
 * displaced by magnitude x in `dir` and held `holdSec`. The attacker makes ONE leaf
 * displacement; each reader sees its read-filtered share (readMove). role 'collateral':
 * the tree prices the collateral, so price up ⇒ ratio up (r = f). role 'debt': the tree
 * prices the borrowed asset, so its value up ⇒ the collateral/debt ratio falls (r = 1/f).
 */
function ratioFactors(exposures: Exposure[], leafId: string, x: number, holdSec: number, dir: Direction): number[] {
  const sign = dir === 'up' ? 1 : -1
  return exposures.map((e) => {
    const f = treeFactor(e.tree, leafId, (read) => Math.exp(sign * readMove(read, x, holdSec)))
    return e.role === 'collateral' ? f : 1 / f
  })
}

function evAt(exposures: Exposure[], leafId: string, x: number, holdSec: number, dir: Direction): { hi: EvBreakdown; pt: EvBreakdown } {
  const r = ratioFactors(exposures, leafId, x, holdSec, dir)
  return { hi: totalEv(exposures, r, 'hi'), pt: totalEv(exposures, r, 'pt') }
}

export function evaluateRatio(input: RatioInput): RatioResult {
  const { leafId, exposures, cost, freeMoves } = input
  const windows = new Set<number>([0])
  for (const e of exposures) collectWindows(e.tree, leafId, windows)
  for (const h of input.extraHolds ?? []) windows.add(h)
  const holds = [...windows].sort((a, b) => a - b)

  const curve: CurvePoint[] = []
  let rLo: number | null = null
  let rPt: number | null = null
  let cLoAtWorst: number | null = null
  let bestLo: RatioResult['best']['lo'] = null
  let bestPt: RatioResult['best']['pt'] = null
  let competitiveNote: string | undefined

  for (const dir of ['up', 'down'] as const) {
    const cFull = cost.full[dir]
    const cTopK = cost.topKRemoved?.[dir]
    if (!cFull) continue
    for (const x of cFull.samples.map((s) => s.x)) {
      // The attacker holds just long enough for the slowest reader to see the move.
      let bestPoint: CurvePoint | null = null
      for (const hold of holds) {
        const { hi, pt } = evAt(exposures, leafId, x, hold, dir)
        if (hi.totalUsd <= 0 && pt.totalUsd <= 0) continue
        const cLoFull = strategyCost(cFull, x, hold, 'passive')
        const cLoTopK = cTopK ? strategyCost(cTopK, x, hold, 'passive') : null
        const cLo = minDefined(cLoFull, cLoTopK)
        const cPt = cLoFull
        const rl = cLo !== null && hi.totalUsd > 0 ? cLo / hi.totalUsd : null
        const rp = cPt !== null && pt.totalUsd > 0 ? cPt / pt.totalUsd : null
        const point: CurvePoint = {
          movePct: (dir === 'up' ? Math.expm1(x) : -Math.expm1(x)) * 100,
          direction: dir,
          holdSec: hold,
          cLoUsd: cLo,
          cPtUsd: cPt,
          evHiUsd: hi.totalUsd,
          evPtUsd: pt.totalUsd,
          rLo: rl,
          rPt: rp,
        }
        // Keep the hold that minimises R_lo for this (dir, x).
        if (!bestPoint || betterLo(point, bestPoint)) bestPoint = point
        if (rl !== null && (rLo === null || rl < rLo)) {
          rLo = rl
          cLoAtWorst = cLo
          bestLo = { direction: dir, x, holdSec: hold, cUsd: cLo!, evUsd: hi.totalUsd }
        }
        if (rp !== null && (rPt === null || rp < rPt)) {
          rPt = rp
          bestPt = { direction: dir, x, holdSec: hold, cUsd: cPt!, evUsd: pt.totalUsd }
        }
        // Competitive cost as context: cheapest hold-bearing competitive cost seen.
        const cc = strategyCost(cFull, x, hold, 'competitive')
        if (cc !== null && hold > 0 && !competitiveNote) {
          competitiveNote = `competitive-regime cost at ${(point.movePct).toFixed(1)}% / ${hold}s ≈ $${fmt(cc)} (if the move is arbitraged back each block)`
        }
      }
      if (bestPoint) curve.push(bestPoint)
    }
  }

  // Free moves: EV at zero manipulation cost.
  let freeEvHi = 0
  let freeEvPt = 0
  for (const fm of freeMoves) {
    for (const dir of fm.directions) {
      const { hi, pt } = evAt(exposures, leafId, fm.x, Number.MAX_SAFE_INTEGER, dir)
      fm.evUsd = Math.max(fm.evUsd ?? 0, hi.totalUsd)
      freeEvHi = Math.max(freeEvHi, hi.totalUsd)
      freeEvPt = Math.max(freeEvPt, pt.totalUsd)
    }
  }

  curve.sort((a, b) => a.movePct - b.movePct)

  const reasons: string[] = []
  let verdict: Verdict = 'green'
  const bump = (v: Verdict, why: string) => {
    reasons.push(why)
    if (v === 'red' || verdict === 'red') verdict = 'red'
    else verdict = v
  }
  // The free-move gates read the REALISTIC free-move EV (position-level where the data
  // exists, else 0). The all-positions-at-edge upper bound (freeEvHi) would make every
  // deep blue-chip feed red on its own deviation band, so it is reported only as context.
  if (input.hardRed) bump('red', `hard-red: ${input.hardRed.reason}`)
  if (freeEvPt >= RULINGS.freeMoveRedUsd) bump('red', `free-move EV $${fmt(freeEvPt)} ≥ $${fmt(RULINGS.freeMoveRedUsd)}`)
  if (rLo !== null && rLo < RULINGS.rLoRed) bump('red', `R_lo ${rLo.toFixed(2)} < ${RULINGS.rLoRed}`)
  if (rPt !== null && rPt < RULINGS.rPtYellow) bump('yellow', `R_pt ${rPt.toFixed(2)} < ${RULINGS.rPtYellow}`)
  if (cLoAtWorst !== null && cLoAtWorst < RULINGS.cLoFloorUsd && (rPt !== null || rLo !== null)) bump('yellow', `C_lo $${fmt(cLoAtWorst)} < $${fmt(RULINGS.cLoFloorUsd)} floor`)
  if (freeEvPt > 0) bump('yellow', `free-move EV present ($${fmt(freeEvPt)})`)
  if (reasons.length === 0) reasons.push('R_lo ≥ 1.5, R_pt ≥ 10, C_lo ≥ $100M, no free-move EV')

  return {
    leafId,
    verdict,
    reasons,
    rLo,
    rPt,
    cLoAtWorstUsd: cLoAtWorst,
    freeMoveEvUsd: freeEvPt,
    freeMoveEvHiUsd: freeEvHi,
    best: { lo: bestLo, pt: bestPt },
    curve,
    competitiveCostNote: competitiveNote,
  }
}

function betterLo(a: CurvePoint, b: CurvePoint): boolean {
  if (a.rLo === null) return false
  if (b.rLo === null) return true
  return a.rLo < b.rLo
}

function minDefined(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

function collectWindows(node: PriceNode, leafId: string, out: Set<number>): void {
  switch (node.op) {
    case 'leaf':
      if (node.leafId === leafId) {
        if (node.read.mode === 'twap') out.add(node.read.windowSec)
        if (node.read.mode === 'ema') out.add(node.read.halfLifeSec)
      }
      return
    case 'const':
      return
    case 'product':
      node.factors.forEach((f) => collectWindows(f.node, leafId, out))
      return
    case 'min':
    case 'max':
      node.of.forEach((c) => collectWindows(c, leafId, out))
      return
    case 'clamp':
      collectWindows(node.node, leafId, out)
  }
}

export function fmt(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(0)
}
