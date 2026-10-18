/**
 * Builds the served Evidence dataset from the FULL on-chain census of 10-11 Oct 2025:
 *
 *   public/data/oct10-2025/evidence-census.json           the Evidence page and the landing's
 *                                                         Close band (summary + 3,197 rows)
 *   public/data/oct10-2025/evidence-census-headline.json  the few figures the landing hero,
 *                                                         the og card and facts.ts import
 *
 *   MEMBRANE_DATASETS_DIR=/path/to/membrane-datasets npx tsx scripts/build-evidence-census.ts
 *
 * SOURCE. The canonical census is <datasets>/oct10-2025/coverage/census.json (built by
 * scripts/oct10-coverage/build-census.ts; rule N18: the data lives in membrane-datasets, only
 * small served copies live here). Every position, every both-side total and every outcome on
 * the page is read from it. Its sha256 is recorded in meta.source.
 *
 * WHAT IS RECOMPUTED, AND HOW. Three things census.json does not carry are computed here by
 * re-running the census's own walk (scripts/oct10-coverage/census.ts buildCensus, the same
 * kernel and the same protocol-oracle minute paths) from the inputs in
 * <datasets>/recall-coverage/inputs/oct10/:
 *   1. the cure diagnostic (curedInWindow / healthyAt8h / minutesToCure / bestLtv / endLtv),
 *      with the SAME definition scripts/build-evidence.ts used: price only, the position's
 *      LTV at each minute from t0 to t0 + 8h against its own line, the minimum (best) and the
 *      last (end). Here the LTV is the whole t0 composition, every leg on its own protocol
 *      oracle path;
 *   2. the one-repay-at-t0 counterfactual (the delay credit) and the first minute back under
 *      the line (where the credit comes from);
 *   3. the sensitivities the census takes as options — the liquidity cap (0.5x, 1.0x, 2.0x,
 *      unlimited), Membrane at the protocol's own line, strict lines, and the kernel's own
 *      (band, early clear, debt floor, one sale, walk-on, t0 basis) — each on ITS OWN compared
 *      set, with both sides, the Aave / Morpho split and the position counts.
 * The headline rerun must reproduce census.json's rows exactly, or the build stops.
 *
 * DEBT REPAID ONLY (owner ruling 2026-10-18). No collateral-seized figure is compared or served:
 * Membrane's liquidation fee cannot be assumed. The headline set is the census's COMPARED set
 * (rows with `mem`): walked, with a Membrane line, and with liquidity for what Membrane sells.
 *
 * DETERMINISTIC. No clock, no randomness, sorted keys where order is not already fixed. The
 * git commit recorded is the last one that touched the code this build runs (CODE_PATHS), so
 * a rerun on any later commit with the same code writes the same bytes.
 *
 * Flags: --no-write (compute and print only).
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { cureSale } from '../lib/position-sim/curePath'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '../lib/position-sim/membrane'
import { isStable } from '../lib/position-sim/collateralClass'
import { kernelLegs, type PositionSpec } from '../lib/wavefront/aave'
import type { KernelLeg } from '../lib/wavefront/kernel'
import {
  CAPACITY_MULTIPLIER,
  CAPACITY_WINDOW_MINUTES,
  MULTIPLIER_BASIS,
  PREVIOUS_CAPACITY_MULTIPLIER,
  RESEARCH_FLOW_READING_MULTIPLIER,
  RESEARCH_LIQUIDITY_CLASSES,
} from '../lib/wavefront/liquidity'
import { AAVE_CORE_POOL } from '../lib/wavefront/pid'
import { datasetsDir } from './lib/datasetsDir.mjs'
import {
  buildCensus,
  censusShares,
  MAX_SALES,
  type CensusOptions,
  type CensusProbe,
  type CensusRow,
} from './oct10-coverage/census'
import { loadCensusInputs } from './oct10-coverage/censusInputs'

const ROOT = process.cwd()
const NO_WRITE = process.argv.includes('--no-write')
const DATASETS = datasetsDir(ROOT)
const CENSUS_PATH = path.join(DATASETS, 'oct10-2025', 'coverage', 'census.json')
const SERVED = path.join(ROOT, 'public', 'data', 'oct10-2025')
const OUT = path.join(SERVED, 'evidence-census.json')
const OUT_HEADLINE = path.join(SERVED, 'evidence-census-headline.json')

/** The code this build runs. The commit recorded is the last one that touched any of it. */
const CODE_PATHS = [
  'scripts/build-evidence-census.ts',
  'scripts/oct10-coverage/census.ts',
  'scripts/oct10-coverage/censusInputs.ts',
  'scripts/oct10-coverage/inputs.ts',
  'lib/wavefront/aave.ts',
  'lib/wavefront/morpho.ts',
  'lib/wavefront/kernel.ts',
  'lib/wavefront/stream.ts',
  'lib/wavefront/pid.ts',
  'lib/wavefront/cluster.ts',
  'lib/wavefront/liquidity.ts',
  'lib/wavefront/membraneLine.ts',
  'lib/position-sim/curePath.ts',
  'lib/position-sim/membrane.ts',
  'lib/position-sim/collateralClass.ts',
]

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const r2 = (x: number) => Math.round(x * 100) / 100
const r4 = (x: number) => Math.round(x * 1e4) / 1e4
const r5 = (x: number) => Math.round(x * 1e5) / 1e5
const pct2 = (x: number) => Math.round(x * 1e4) / 100
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
function median(xs: readonly number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const fail = (msg: string): never => {
  throw new Error(`build-evidence-census: ${msg}`)
}

// ---- the canonical census ---------------------------------------------------------------
const censusBuf = fs.readFileSync(CENSUS_PATH)
const census = JSON.parse(censusBuf.toString('utf8')) as {
  meta: any
  rows: CensusRow[]
}
const M = census.meta
const allRows = census.rows
if (allRows.length !== M.coverage.total) fail('row count != meta.coverage.total')
if (allRows.some((r) => !r.walked || !r.t0)) fail('every census row must be walked')
if (allRows.some((r) => !r.mem !== !!r.excluded)) fail('a row is compared iff it is not excluded')
/** The COMPARED set: every total, median and row on the page is over these. */
const rows = allRows.filter((r) => r.mem)
if (rows.length !== M.coverage.compared) fail('compared rows != meta.coverage.compared')

// ---- rerun the walk: probe for the cure diagnostic, one repay and first cure ---------------
const inputs = loadCensusInputs(DATASETS)
const W = inputs.window
const LAST_MINUTE = W.minutes - 1
const DELAY_STEPS = Math.round(CURE_WINDOW_SECONDS / W.stepSeconds)

interface Cure {
  curedInWindow: boolean
  healthyAt8h: boolean
  minutesToCure: number | null
  bestLtv: number
  endLtv: number
  noWindow: boolean
  wouldHaveCuredWithWindow: boolean
}
interface Probed {
  cure: Cure | null
  /** One repay to cap at t0 per half over its line, USD at t0 (null: unpriced loan). */
  oneRepayUsd: number | null
  /** First minute back under the line after a breach, over the halves (kernel). */
  minutesToFirstCure: number | null
}

function probeOf(p: CensusProbe): Probed {
  const s: PositionSpec = p.spec
  const t0 = s.t0!.minute
  // The line WALKED (Membrane's own in the headline), and the class on it.
  const line = p.line
  // the LTV Membrane walks: sized to its line (debtScale; 1 when unscaled)
  const ltv0 = (s.ltv0 as number) * p.debtScale

  // --- the cure diagnostic: build-evidence.ts's definition on the whole t0 composition.
  // LTV(i) = ltv0 / R(i), R = sum(w_c r_c) / sum(w_d r_d) with t0 value weights (kernel.ts
  // MULTI-LEG PRICE INPUT); i = 0 is t0 itself (R = 1); i1 = min(8h, the grid end).
  const legs = (xs: PositionSpec['collateral']): KernelLeg[] =>
    xs.map((l) => ({ key: l.key, symbol: l.symbol, value0: l.value0 }))
  const coll = legs(s.collateral).filter((l) => l.value0 > 0)
  const debt = legs(s.debt).filter((l) => l.value0 > 0)
  const cTot = sum(coll.map((l) => l.value0))
  const dTot = sum(debt.map((l) => l.value0))
  const i1 = Math.min(DELAY_STEPS, LAST_MINUTE - t0)
  let cure: Cure | null = null
  if (i1 > 0 && cTot > 0 && dTot > 0) {
    let best = Infinity
    let bestMin = 0
    let end = ltv0
    for (let i = 0; i <= i1; i++) {
      let ltv = ltv0
      if (i > 0) {
        const m = t0 + i
        const c = sum(coll.map((l) => (l.value0 / cTot) * p.ratioAt(l, m)))
        const d = sum(debt.map((l) => (l.value0 / dTot) * p.ratioAt(l, m)))
        ltv = ltv0 / (c / d)
      }
      if (ltv < best) {
        best = ltv
        bestMin = (i * W.stepSeconds) / 60
      }
      if (i === i1) end = ltv
    }
    const noWindow = p.delayClass === 'no-delay'
    cure = {
      curedInWindow: !noWindow && best <= line,
      healthyAt8h: end <= line,
      minutesToCure: !noWindow && best <= line ? bestMin : null,
      bestLtv: r5(best),
      endLtv: r5(end),
      noWindow,
      wouldHaveCuredWithWindow: noWindow && best <= line,
    }
  }

  // --- one repay to cap at t0, no window: each half over its own line takes the same
  // cureSale the kernel runs at t0 (repay-to-cap, the floor). Not liquidity-capped: the delay
  // credit is computed against the UNLIMITED walk, so neither side carries the cap.
  let oneUnits = 0
  for (const h of p.halves) {
    if (!(ltv0 > h.line)) continue
    const kl = kernelLegs(s, h)
    const d = sum(kl.debt.map((l) => l.value0))
    const c = sum(kl.collateral.map((l) => l.value0))
    const sale = cureSale({ debt: d, collBase: c, sales: 0 }, 1, {
      cap: Math.max(0, h.line - BORROW_LTV_GAP),
      debtMinimumUsd: s.debtMinimum,
      repayCap: Infinity,
      maxSales: MAX_SALES,
    })
    oneUnits += sale.repaid
  }
  const f = p.usdPerUnit(t0)
  const oneRepayUsd = f == null || !Number.isFinite(f) ? null : oneUnits * f

  const firsts = p.results.map((r) => r.minutesToFirstCure).filter((x): x is number => x != null)
  return { cure, oneRepayUsd, minutesToFirstCure: firsts.length ? Math.min(...firsts) : null }
}

const probed = new Map<string, Probed>()
const headline = buildCensus(inputs, {
  probe: (p) => probed.set(p.spec.pid, probeOf(p)),
})
if (headline.rows.length !== allRows.length) fail('rerun row count differs from census.json')
for (let i = 0; i < allRows.length; i++) {
  if (JSON.stringify(headline.rows[i]) !== JSON.stringify(allRows[i])) {
    fail(
      `the rerun does not reproduce census.json row ${i} (${allRows[i].pid}); rebuild the census`,
    )
  }
}
if (probed.size !== rows.length) fail('the probe did not see every compared position')

// Grid-end sales, per position, from the rerun's own stream (why: grid-end).
const gridEndUsd = new Map<string, number>()
for (const rec of headline.records) {
  if (rec.kind === 'mem' && rec.why === 'grid-end' && rec.repaidUsd != null) {
    gridEndUsd.set(rec.pid, (gridEndUsd.get(rec.pid) ?? 0) + rec.repaidUsd)
  }
}

// ---- sensitivities: the same census, one rule changed, EACH ON ITS OWN COMPARED SET ----------
const memDollars = (rs: readonly CensusRow[]) => r2(sum(rs.map((r) => r.mem?.repaidUsd ?? 0)))
/**
 * THE SHARE OF DEBT CLOSED (owner ruling 2026-10-18, second round). The two sides carry
 * different debt (Membrane's is sized to its own line), so dollars do not compare; the share of
 * each side's OWN t0 debt does:
 *   real share     = Σ real repaid / Σ real debt at t0            (every real event, USD)
 *   Membrane share = Σ Membrane closed / Σ Membrane debt at t0     (on the t0 basis:
 *                    closedT0 / mem.debt0 per position, weighted by mem.debt0Usd)
 * both debt-weighted over the run's PRICED compared positions. gapPp = (real − Membrane) in
 * percentage points: positive = Membrane closes a smaller share. Per position, the two
 * fractions are compared at 1e-5 (the published precision): less / more / equal; `lessSet`
 * and `moreSet` give both shares over each side of that split (what the net is made of).
 */
const realFracOf = (r: CensusRow) =>
  r.debtUsd != null && r.debtUsd > 0 ? r.real.repaidUsd / r.debtUsd : null
const memFracOf = (r: CensusRow) => (r.mem && r.mem.debt0 > 0 ? r.mem.closedT0 / r.mem.debt0 : null)
const pricedRow = (r: CensusRow) =>
  r.debtUsd != null &&
  r.collUsd != null &&
  r.real.unpricedEvents === 0 &&
  !!r.mem &&
  r.mem.unpricedSales === 0 &&
  r.mem.debt0Usd != null &&
  r.mem.debt0 > 0 &&
  r.debtUsd > 0
function shareFigures(xs: readonly CensusRow[]) {
  const p = xs.filter(pricedRow)
  const realDebt = sum(p.map((r) => r.debtUsd!))
  const memDebt = sum(p.map((r) => r.mem!.debt0Usd!))
  const shares = (ys: readonly CensusRow[]) => {
    const rd = sum(ys.map((r) => r.debtUsd!))
    const md = sum(ys.map((r) => r.mem!.debt0Usd!))
    return {
      positions: ys.length,
      realShare: rd > 0 ? r5(sum(ys.map((r) => r.real.repaidUsd)) / rd) : 0,
      memShare: md > 0 ? r5(sum(ys.map((r) => memFracOf(r)! * r.mem!.debt0Usd!)) / md) : 0,
    }
  }
  const cmpOf = (r: CensusRow) => {
    const a = r5(realFracOf(r)!)
    const m = r5(memFracOf(r)!)
    return m < a ? 'less' : m > a ? 'more' : 'equal'
  }
  const less = p.filter((r) => cmpOf(r) === 'less')
  const more = p.filter((r) => cmpOf(r) === 'more')
  const sh = censusShares(p)
  return {
    positions: xs.length,
    pricedPositions: p.length,
    /** The real side's dollars: the size of the day on this set (not a comparison). */
    realRepaidUsd: r2(sum(xs.map((r) => r.real.repaidUsd))),
    realDebtUsd: r2(realDebt),
    /** Membrane's own t0 debt, sized to its line (†). */
    memDebtUsd: r2(memDebt),
    realShare: sh.realShare,
    memShare: sh.memShare,
    gapPp: sh.gapPp,
    less: less.length,
    more: more.length,
    equal: p.length - less.length - more.length,
    lessSet: shares(less),
    moreSet: shares(more),
  }
}
/** A run's figures over its own compared set, with the split and its exclusions. */
function setFigures(rs: readonly CensusRow[]) {
  const cmp = rs.filter((r) => r.mem)
  return {
    ...shareFigures(cmp),
    byProtocol: {
      'aave-v3': shareFigures(cmp.filter((r) => r.protocol === 'aave-v3')),
      'morpho-blue': shareFigures(cmp.filter((r) => r.protocol === 'morpho-blue')),
    },
    excluded: {
      noMembraneLine: rs.filter((r) => r.excluded === 'no-membrane-line').length,
      partialMembraneLine: rs.filter((r) => r.excluded === 'partial-membrane-line').length,
      noCapacity: rs.filter((r) => r.excluded === 'no-capacity').length,
    },
  }
}
type SetFigures = ReturnType<typeof setFigures>
const sensRuns = new Map<string, CensusRow[]>()
/**
 * One run, one rule changed, on its OWN compared set: Membrane's share of its own t0 debt with
 * the Aave / Morpho split, the net gap in percentage points, the set's figures. Membrane's
 * dollars are kept only to check the census's own published sensitivities; never served.
 */
function sensitivity(key: string, opts: CensusOptions) {
  const res = buildCensus(inputs, opts)
  sensRuns.set(key, res.rows)
  const byPid = new Map(allRows.map((r) => [r.pid, r]))
  const changed = res.rows.filter(
    (r) => Math.abs((r.mem?.repaidUsd ?? 0) - (byPid.get(r.pid)!.mem?.repaidUsd ?? 0)) > 0.005,
  ).length
  const f = setFigures(res.rows)
  return {
    memShare: f.memShare,
    byProtocol: {
      'aave-v3': f.byProtocol['aave-v3'].memShare,
      'morpho-blue': f.byProtocol['morpho-blue'].memShare,
    },
    gapPp: f.gapPp,
    positionsChanged: changed,
    set: f,
    memDollarsCheck: memDollars(res.rows),
  }
}
const served = <T extends { memDollarsCheck: number }>({ memDollarsCheck: _m, ...rest }: T) => rest
const headlineSet = setFigures(allRows)
const bands = [0.02, MAX_THRESHOLD_TO_DELAY, 0.08]
const bandSensitivity = bands.map((band) => {
  if (band === MAX_THRESHOLD_TO_DELAY) {
    return {
      band,
      memShare: headlineSet.memShare,
      byProtocol: {
        'aave-v3': headlineSet.byProtocol['aave-v3'].memShare,
        'morpho-blue': headlineSet.byProtocol['morpho-blue'].memShare,
      },
      set: headlineSet,
    }
  }
  const s = sensitivity(`band${band}`, { band })
  return { band, memShare: s.memShare, byProtocol: s.byProtocol, set: s.set }
})
const noEarlyClear = sensitivity('noEarlyClear', { noEarlyClear: true })
const noDebtFloor = sensitivity('noDebtFloor', { noDebtFloor: true })
const singleSale = sensitivity('singleSale', { maxSales: 1 })
// The census's own two sensitivities, rerun here so each carries its per-protocol split; the
// totals must be the ones census.json publishes.
const noWalkOn = sensitivity('noWalkOn', { stopAfterT0BandSale: true })
const nm1First = sensitivity('nm1First', { basisOrder: ['N-1', 'N'] })
if (
  Math.abs(noWalkOn.memDollarsCheck - M.sensitivity.noWalkOnAfterT0BandSale.memRepaidUsd) > 0.011
) {
  fail('noWalkOnAfterT0BandSale rerun differs from census.json')
}
if (
  Math.abs(
    nm1First.memDollarsCheck - M.sensitivity.t0PriceBasis.wholeCensusAtNm1FirstMemRepaidUsd,
  ) > 0.011
) {
  fail('t0PriceBasis rerun differs from census.json')
}
// THE LIQUIDITY CAP AND THE LINE (owner ruling 2026-10-18).
const MULTIPLIERS = [0.5, CAPACITY_MULTIPLIER, 1.0, PREVIOUS_CAPACITY_MULTIPLIER, 2.0, Infinity]
const capacityRuns = MULTIPLIERS.map((m) => {
  if (m === CAPACITY_MULTIPLIER) return { multiplier: m, set: headlineSet }
  const s = sensitivity(`cap${m}`, { capacityMultiplier: m })
  return { multiplier: m, set: s.set }
})
const unlimitedRows = sensRuns.get('capInfinity')!
// The liquidity-recovery research (membrane-datasets q28/liquidity-recovery REPORT.md):
// per-class multipliers, and the literal absorbed-flow reading at 0.2x everywhere.
const researchPerClass = sensitivity('capResearch', { capacityMultiplier: 'research-per-class' })
const researchMedians = sensitivity('capMedians', { capacityMultiplier: 'research-medians' })
const researchFlow = sensitivity('capFlow', {
  capacityMultiplier: RESEARCH_FLOW_READING_MULTIPLIER,
})
for (const r of [researchPerClass, researchMedians, researchFlow]) {
  if (r.set.positions !== headlineSet.positions) fail('a research run is not on the headline set')
}
const protocolLine = sensitivity('protocolLine', { lineMode: 'protocol' })
const protocolLineUnlimited = sensitivity('protocolLineUnlimited', {
  lineMode: 'protocol',
  capacityMultiplier: Infinity,
})
// The first round's two choices, each as one row: the partial-line set (legs with no line
// left out of the weighted line), and Membrane's line without sizing the debt to it.
const partialLines = sensitivity('partialLines', { allowPartialLines: true })
const noDebtScaling = sensitivity('noDebtScaling', { noDebtScaling: true })
// QUEUE ORDER (review 2026-10-18): the headline's OWN positions, with the excluded partial-line
// positions also walked and drawing on the shared book first whenever their minute (then pid)
// comes first. The partial-line run is exactly that; its headline-set rows are the row.
const headlinePids = new Set(rows.map((r) => r.pid))
const queueRows = sensRuns.get('partialLines')!.filter((r) => headlinePids.has(r.pid))
if (queueRows.length !== rows.length || queueRows.some((r) => !r.mem)) {
  fail('queue-order: the partial-line run does not hold the headline set')
}
const queueOrder = setFigures(queueRows)
queueOrder.excluded = { ...setFigures(allRows).excluded }

/**
 * HOW THE DEBT IS SIZED (review 2026-10-18), over the compared positions: memLine / protocolLine
 * per half. It is LOWER for most positions; it is HIGHER where Membrane's line is above the
 * protocol's (mostly stablecoin collateral: Membrane 0.87 against Aave's 0.78). The proportional
 * distance is kept for an unsplit position; a split position keeps it only PER HALF, each half
 * against the LT-weighted line of its own legs, so a half can open under its own line.
 */
const sizing = (() => {
  const scaleOf = (r: CensusRow) => r.memLine?.debtScale ?? 1
  const up = rows.filter((r) => scaleOf(r) > 1 + 1e-9)
  const down = rows.filter((r) => scaleOf(r) < 1 - 1e-9)
  const splits = rows.filter((r) => (r.memLine?.halves?.length ?? 0) > 1)
  const halfUnder = splits.filter((r) => (r.t0Decisions ?? []).includes('under'))
  const scales = rows.map(scaleOf)
  return {
    rule: 'memDebt0_h = debt0 x share_h x (memLine_h / protocolLine_h) (lib/wavefront/membraneLine.ts membraneDebtScale). Unsplit: the position sits as far past Membrane’s line, proportionally, as it sat past the protocol’s, so its t0 decision is the protocol’s own. Split: that holds per half only, each half against the LT-weighted protocol line of its own legs, so a half can open under its own line.',
    positions: rows.length,
    scaledDown: down.length,
    scaledUp: up.length,
    scaledUpHoldingStables: up.filter((r) => r.collateral.some((c) => isStable(c.symbol))).length,
    unchanged: rows.length - up.length - down.length,
    minScale: Math.round(Math.min(...scales) * 1e4) / 1e4,
    maxScale: Math.round(Math.max(...scales) * 1e4) / 1e4,
    splits: splits.length,
    splitsWithAHalfUnderItsLine: halfUnder.length,
  }
})()
for (const c of capacityRuns) {
  if (c.set.positions !== headlineSet.positions) {
    fail(`capacity x${c.multiplier} is not on the headline's positions`)
  }
}

/** One row of the published sensitivity table: what changed, both sides, the split, the set. */
const sensRow = (key: string, label: string, rule: string, f: SetFigures, headline = false) => ({
  key,
  label,
  rule,
  headline,
  ...f,
})
const capLabel = (m: number) =>
  m === Infinity ? 'unlimited (the old assumption)' : `${m}x capacity`
const sensitivityTable = [
  ...capacityRuns.map((c) =>
    sensRow(
      `capacity-${c.multiplier === Infinity ? 'unlimited' : c.multiplier}`,
      capLabel(c.multiplier) +
        (c.multiplier === CAPACITY_MULTIPLIER
          ? ' (headline)'
          : c.multiplier === PREVIOUS_CAPACITY_MULTIPLIER
            ? ' (the previous headline)'
            : ''),
      c.multiplier === Infinity
        ? 'Every sale fills at once at the oracle price, in any size: the assumption before 2026-10-18. Same positions as the headline.'
        : `Membrane's sales of a token on a chain share ${c.multiplier}x the most tokens liquidators absorbed in any rolling ${CAPACITY_WINDOW_MINUTES} minutes of the window.` +
            (c.multiplier === CAPACITY_MULTIPLIER ? ` † ${MULTIPLIER_BASIS}.` : ''),
      c.set,
      c.multiplier === CAPACITY_MULTIPLIER,
    ),
  ),
  sensRow(
    'capacity-research-per-class',
    'research per-class, recommended',
    `The liquidity-recovery research's recommended class multipliers on the 10-minute capacity: ${RESEARCH_LIQUIDITY_CLASSES.map((c) => `${c.label} ${c.recommended}x`).join(', ')} (lib/wavefront/liquidity.ts RESEARCH_LIQUIDITY_CLASSES). Same positions as the headline.`,
    researchPerClass.set,
  ),
  sensRow(
    'capacity-research-medians',
    'research per-class medians',
    `The measured median depth recovery 8h after five crashes, per class: ${RESEARCH_LIQUIDITY_CLASSES.map((c) => `${c.label} ${c.median}x`).join(', ')}; the headline ${CAPACITY_MULTIPLIER}x is their mean. Same positions as the headline.`,
    researchMedians.set,
  ),
  sensRow(
    'capacity-research-flow',
    `research per-class + flow reading (${RESEARCH_FLOW_READING_MULTIPLIER}x everywhere)`,
    `The literal reading of absorbed flow: ${RESEARCH_FLOW_READING_MULTIPLIER}x the 10-minute capacity for every token. Same positions as the headline.`,
    researchFlow.set,
  ),
  sensRow(
    'protocol-line',
    `Membrane at the protocol's own line, no debt scaling, ${CAPACITY_MULTIPLIER}x capacity`,
    "Each position walked at its protocol's line (Aave weighted LT, Morpho LLTV) on the real debt; every position with a located t0 is back in (no line is needed). Its own compared set.",
    protocolLine.set,
  ),
  sensRow(
    'protocol-line-unlimited',
    "Membrane at the protocol's own line, no debt scaling, unlimited",
    'The census before 2026-10-18 less the positions that would have to sell a token with no observed liquidity.',
    protocolLineUnlimited.set,
  ),
  sensRow(
    'no-debt-scaling',
    `Membrane's line without debt scaling, ${CAPACITY_MULTIPLIER}x capacity`,
    "The first 2026-10-18 method: Membrane's line on the REAL t0 debt (not sized to its line). Same positions as the headline.",
    noDebtScaling.set,
  ),
  sensRow(
    'partial-lines',
    `partial-line set (first-round rule), ${CAPACITY_MULTIPLIER}x capacity`,
    "Positions where SOME collateral has no Membrane line are back in, those legs left out of the weighted line (the per-wallet simulator's rule). Its own compared set.",
    partialLines.set,
  ),
  sensRow(
    'queue-with-partial-lines',
    `headline set, partial-line positions also on the book, ${CAPACITY_MULTIPLIER}x capacity`,
    "The headline's own positions; the excluded partial-line positions are walked too and draw on the shared liquidity book in queue order (minute, then pid), so they can take capacity first. Same positions as the headline.",
    queueOrder,
  ),
  ...bandSensitivity
    .filter((b) => b.band !== MAX_THRESHOLD_TO_DELAY)
    .map((b) =>
      sensRow(
        `band-${b.band}`,
        `band ${(b.band * 100).toFixed(0)}%`,
        `The delay band at ${(b.band * 100).toFixed(0)}% instead of 4%.`,
        b.set,
      ),
    ),
  sensRow(
    'no-early-clear',
    'nobody clears the timer early',
    'A return under the line does not stop the timer.',
    noEarlyClear.set,
  ),
  sensRow(
    'no-debt-floor',
    'no $2,000 floor',
    'Every sale is the bare repay to cap.',
    noDebtFloor.set,
  ),
  sensRow(
    'single-sale',
    'one sale per position',
    'The walk stops after the first sale (its pending remainder still fills).',
    singleSale.set,
  ),
  sensRow(
    'no-walk-on',
    'stop after a sale at t0',
    M.sensitivity.noWalkOnAfterT0BandSale.rule,
    noWalkOn.set,
  ),
  sensRow('t0-n-1', 't0 at block N-1 prices', M.sensitivity.t0PriceBasis.rule, nm1First.set),
]

// ---- the whale: the sale the cap was ruled for --------------------------------------------
const WHALE =
  'aave-v3:mainnet:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x372cae7fa19b81a9786a9081704ea1e2dad576b7'
const whaleOf = (rs: readonly CensusRow[] | undefined) => {
  const r = rs?.find((x) => x.pid === WHALE)
  return r
    ? {
        memRepaidUsd: r.mem ? r2(r.mem.repaidUsd) : null,
        memFrac: r.mem && r.mem.debt0 > 0 ? r5(r.mem.closedT0 / r.mem.debt0) : null,
        excluded: r.excluded ?? null,
      }
    : null
}
const whaleRow = allRows.find((r) => r.pid === WHALE) ?? fail('the whale is not in the census')
const aaveCap = M.liquidity.capacity.find(
  (c: any) => c.key === 'mainnet:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
)
const whale = {
  pid: WHALE,
  collateral: whaleRow.collateral.map((l) => ({
    symbol: l.symbol,
    amount: r2(l.amount),
    usd: l.usd == null ? null : r2(l.usd),
  })),
  debtUsd: whaleRow.debtUsd == null ? null : r2(whaleRow.debtUsd),
  protocolLine: whaleRow.line,
  ltv0: whaleRow.ltv0,
  realEvents: whaleRow.real.events,
  realRepaidUsd: r2(whaleRow.real.repaidUsd),
  headline: whaleOf(allRows),
  protocolLineCapped: whaleOf(sensRuns.get('protocolLine')),
  protocolLineUnlimited: whaleOf(sensRuns.get('protocolLineUnlimited')),
  aaveMainnetCapacityTokens: aaveCap ? aaveCap.capacityTokens : null,
  aaveMainnetLiquidatorTokens: aaveCap ? aaveCap.liquidatorCapacityTokens : null,
}

// ---- per position ---------------------------------------------------------------------------
const FLOOR = LIQ_DEBT_MINIMUM_USD
interface Pos {
  r: CensusRow
  priced: boolean
  real: number
  /** Membrane's dollars (†): its own debt, so never shown as a like-for-like comparison. */
  mem: number
  realFrac: number | null
  memFrac: number | null
  cmp: 'less' | 'more' | 'equal' | 'unpriced'
  probe: Probed
  gridEnd: number
}
const pos: Pos[] = rows.map((r) => {
  const priced = pricedRow(r)
  const realFrac = priced ? realFracOf(r) : null
  const memFrac = priced ? memFracOf(r) : null
  // Compared on the published precision (1e-5), the share of each side's own t0 debt.
  const cmp: Pos['cmp'] =
    realFrac == null || memFrac == null
      ? 'unpriced'
      : r5(memFrac) < r5(realFrac)
        ? 'less'
        : r5(memFrac) > r5(realFrac)
          ? 'more'
          : 'equal'
  return {
    r,
    priced: realFrac != null && memFrac != null,
    real: r.real.repaidUsd,
    mem: r.mem!.repaidUsd,
    realFrac,
    memFrac,
    cmp,
    probe: probed.get(r.pid)!,
    gridEnd: gridEndUsd.get(r.pid) ?? 0,
  }
})

// ---- the debt sets ------------------------------------------------------------------------------
const PROTOCOL_LABEL: Record<string, string> = {
  'aave-v3': 'Aave V3',
  'morpho-blue': 'Morpho Blue',
}
const CHAIN_LABEL: Record<string, string> = {
  mainnet: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  base: 'Base',
}
const medianBlock = (ps: readonly Pos[]) => {
  const pr = ps.filter((p) => p.realFrac != null && p.memFrac != null)
  return {
    positions: pr.length,
    realMedianFrac: r5(median(pr.map((p) => p.realFrac!))),
    memMedianFrac: r5(median(pr.map((p) => p.memFrac!))),
    medianDebtUsd: r2(median(pr.map((p) => p.r.debtUsd!))),
  }
}
/**
 * Which positions the net share gap rests on. Each priced position contributes
 * real_i / Σ real debt − Membrane closed_i / Σ Membrane debt (its part of each side's share);
 * the contributions sum to the net gap exactly. In percentage points.
 */
function concentration(ps: readonly Pos[]) {
  const pr = ps.filter((p) => p.priced)
  const rd = sum(pr.map((p) => p.r.debtUsd!))
  const md = sum(pr.map((p) => p.r.mem!.debt0Usd!))
  const g = pr
    .map((p) => ({
      p,
      gap: 100 * (p.real / rd - (p.memFrac! * p.r.mem!.debt0Usd!) / md),
    }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || (a.p.r.pid < b.p.r.pid ? -1 : 1))
  const net = sum(g.map((x) => x.gap))
  const abs = sum(g.map((x) => Math.abs(x.gap)))
  const top = (n: number) => g.slice(0, n)
  const brief = (x: { p: Pos; gap: number }) => ({
    pid: x.p.r.pid,
    protocol: x.p.r.protocol,
    chain: x.p.r.chain,
    owner: x.p.r.owner,
    gapPp: r4(x.gap),
    realFrac: r5(x.p.realFrac!),
    memFrac: r5(x.p.memFrac!),
    outcome: x.p.r.mem!.outcome,
  })
  return {
    shareDenominator:
      'sum over positions of |its contribution to the net share gap| (percentage points)',
    gapAbsolutePp: r4(abs),
    top1Share: abs > 0 ? r4(Math.abs(g[0].gap) / abs) : 0,
    top5Share: abs > 0 ? r4(sum(top(5).map((x) => Math.abs(x.gap))) / abs) : 0,
    top5: top(5).map(brief),
    gapWithoutTop1Pp: r4(net - sum(top(1).map((x) => x.gap))),
    gapWithoutTop5Pp: r4(net - sum(top(5).map((x) => x.gap))),
  }
}
function debtSet(key: string, label: string, ps: readonly Pos[]) {
  const f = shareFigures(ps.map((p) => p.r))
  const ge = ps.filter((p) => p.r.mem!.armedAtGridEnd)
  return {
    key,
    label,
    ...f,
    unpricedPositions: f.positions - f.pricedPositions,
    events: sum(ps.map((p) => p.r.real.events)),
    realBadDebtUsd: r2(sum(ps.map((p) => p.r.real.badDebtUsd))),
    memNeverSold: ps.filter((p) => p.r.mem!.sales === 0).length,
    gridEnd: {
      positions: ge.length,
      /** Membrane's closed debt booked at the grid end, as a share of its t0 debt (†). */
      memShare:
        f.memDebtUsd > 0
          ? r5(sum(ge.filter((p) => p.priced).map((p) => p.gridEnd)) / f.memDebtUsd)
          : 0,
    },
    medians: {
      all: medianBlock(ps),
      atLeastFloor: medianBlock(ps.filter((p) => (p.r.debtUsd ?? 0) >= FLOOR)),
      floorUsd: FLOOR,
    },
    concentration: concentration(ps),
  }
}
const byProtocol = (k: string) => pos.filter((p) => p.r.protocol === k)
const all = debtSet('all', 'Aave V3 and Morpho Blue, four chains', pos)
const aave = debtSet('aave-v3', PROTOCOL_LABEL['aave-v3'], byProtocol('aave-v3'))
const morpho = debtSet('morpho-blue', PROTOCOL_LABEL['morpho-blue'], byProtocol('morpho-blue'))
const vcKeys = [...new Set(rows.map((r) => `${r.venue}:${r.chain}`))].sort()
const byVenueChain = vcKeys.map((k) => {
  const ps = pos.filter((p) => `${p.r.venue}:${p.r.chain}` === k)
  const r = ps[0].r
  const venue =
    r.protocol === 'aave-v3'
      ? `Aave V3 ${r.marketLabel === 'core' ? 'Core' : r.marketLabel[0].toUpperCase() + r.marketLabel.slice(1)}`
      : 'Morpho Blue'
  const s = debtSet(k, `${venue} · ${CHAIN_LABEL[r.chain] ?? r.chain}`, ps)
  // The per-chain rows carry totals only; the concentration lives on the three big sets.
  const { concentration: _c, medians: _m, ...rest } = s
  return { ...rest, protocol: r.protocol, chain: r.chain }
})

// ---- integrity: every total equals census.meta.totals ------------------------------------------
const close = (a: number, b: number, what: string) => {
  if (Math.abs(a - b) > 0.011) fail(`${what}: ${a} != census ${b}`)
}
close(all.realRepaidUsd, M.totals.all.realWalked.repaidUsd, 'real repaid')
close(all.realShare, M.totals.all.shares.realShare, 'real share')
close(all.memShare, M.totals.all.shares.memShare, 'Membrane share')
for (const [k, s] of [
  ['aave-v3', aave],
  ['morpho-blue', morpho],
] as const) {
  close(s.realRepaidUsd, M.totals.byProtocol[k].realWalked.repaidUsd, `${k} real repaid`)
  close(s.memShare, M.totals.byProtocol[k].shares.memShare, `${k} Membrane share`)
  if (s.positions !== M.totals.byProtocol[k].compared) fail(`${k} positions`)
}
for (const v of byVenueChain) {
  const t = M.totals.byProtocolChain[v.key]
  if (!t) fail(`no census total for ${v.key}`)
  close(v.realRepaidUsd, t.realWalked.repaidUsd, `${v.key} real repaid`)
  close(v.memShare, t.shares.memShare, `${v.key} Membrane share`)
  if (v.positions !== t.compared) fail(`${v.key} positions`)
}
if (all.events !== M.totals.all.realWalked.events) fail('events')
if (all.memNeverSold !== M.totals.all.mem.positionsKept) fail('positions never sold')
if (all.gridEnd.positions !== M.totals.all.mem.positionsSoldAtGridEnd) fail('grid-end positions')

// ---- time: outcomes, the cure diagnostic, the delay credit -------------------------------------
const outcomeCount = (ps: readonly Pos[]) => {
  const o: Record<string, number> = {}
  for (const p of ps) o[p.r.mem!.outcome] = (o[p.r.mem!.outcome] ?? 0) + 1
  return Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
}
const outcomes = outcomeCount(pos)
for (const [k, v] of Object.entries(M.outcomes as Record<string, number>)) {
  if (outcomes[k] !== v) fail(`outcome ${k}: ${outcomes[k]} != census ${v}`)
}
const cur = pos.filter((p) => p.probe.cure)
const cured = cur.filter((p) => p.probe.cure!.curedInWindow)
const healthy = cur.filter((p) => p.probe.cure!.healthyAt8h)
const noWin = cur.filter((p) => p.probe.cure!.noWindow)
const cureSummary = (ps: readonly Pos[]) => {
  const c = ps.filter((p) => p.probe.cure)
  const k = c.filter((p) => p.probe.cure!.curedInWindow)
  const h = c.filter((p) => p.probe.cure!.healthyAt8h)
  return {
    accountsAnalysed: c.length,
    curedInWindow: k.length,
    curedPct: c.length ? pct2(k.length / c.length) : 0,
    healthyAt8h: h.length,
    healthyAt8hPct: c.length ? pct2(h.length / c.length) : 0,
    medianMinutesToCure: median(k.map((p) => p.probe.cure!.minutesToCure!)),
  }
}

// The delay credit: one repay to cap at t0 (no window) minus the walk, on the positions whose
// loan has a USD price (the same set every dollar total uses). BOTH SIDES UNCAPPED: one repay at
// t0 is not offered to the liquidity book, so it is set against the UNLIMITED walk on the same
// positions (the capacity sensitivity 'unlimited'), never against the capped headline.
const priced = pos.filter((p) => p.priced)
const unlimitedMem = new Map(unlimitedRows.map((r) => [r.pid, r.mem?.repaidUsd ?? 0]))
const memUnl = (p: Pos) => unlimitedMem.get(p.r.pid) ?? fail(`no unlimited walk for ${p.r.pid}`)
const oneRepayOf = (ps: readonly Pos[]) => sum(ps.map((p) => p.probe.oneRepayUsd ?? 0))
const creditOf = (p: Pos) => Math.max(0, (p.probe.oneRepayUsd ?? 0) - memUnl(p))
const curedRows = priced.filter((p) => p.probe.minutesToFirstCure != null)
const cureCreditUsd = sum(curedRows.map(creditOf))
const within = (mins: number) =>
  cureCreditUsd > 0
    ? pct2(
        sum(curedRows.filter((p) => p.probe.minutesToFirstCure! <= mins).map(creditOf)) /
          cureCreditUsd,
      )
    : 0
const oneRepay = {
  basis:
    'Both sides without the liquidity cap: one repay to cap at t0 against the unlimited walk on the same positions.',
  memOneRepayUsd: r2(oneRepayOf(priced)),
  memWalkUnlimitedUsd: r2(sum(priced.map(memUnl))),
  delayCreditUsd: r2(oneRepayOf(priced) - sum(priced.map(memUnl))),
  byProtocol: Object.fromEntries(
    (['aave-v3', 'morpho-blue'] as const).map((k) => {
      const ps = priced.filter((p) => p.r.protocol === k)
      const one = oneRepayOf(ps)
      return [k, { memOneRepayUsd: r2(one), delayCreditUsd: r2(one - sum(ps.map(memUnl))) }]
    }),
  ),
  cureCreditUsd: r2(cureCreditUsd),
  cureCreditShareWithin2min: within(2),
  cureCreditShareWithin1h: within(60),
  cureCreditShareWithin8h: within(DELAY_STEPS),
  cureCreditGrossUsd: r2(sum(priced.map(creditOf))),
  counterCreditUsd: r2(sum(priced.map((p) => Math.max(0, memUnl(p) - (p.probe.oneRepayUsd ?? 0))))),
  counterCreditPositions: priced.filter((p) => memUnl(p) > (p.probe.oneRepayUsd ?? 0) + 0.01)
    .length,
}

// Fresh oracle prints: minutes where the mainnet AaveOracle WETH price differs from the minute
// before (a cure needs a price that moves). Every chain has its own; mainnet WETH is the
// reference figure the page quotes.
const MAINNET_CORE = `mainnet:${AAVE_CORE_POOL.mainnet}`
const mainnetOracle = inputs.aaveOracle[MAINNET_CORE] ?? fail('no mainnet AaveOracle path')
const wethAddr = (
  mainnetOracle.assets.find((a) => a.symbol === 'WETH') ?? fail('no WETH on the mainnet path')
).address
const wethCol = mainnetOracle.prices[wethAddr] ?? fail('no WETH column')
let freshWethMinutes = 0
for (let m = 1; m < wethCol.length; m++) if (wethCol[m] !== wethCol[m - 1]) freshWethMinutes++

const neverSold = pos.filter((p) => p.r.mem!.sales === 0)
const time = {
  outcomes,
  outcomesByProtocol: {
    'aave-v3': outcomeCount(byProtocol('aave-v3')),
    'morpho-blue': outcomeCount(byProtocol('morpho-blue')),
  },
  /**
   * The outcome is the LARGER half's. A split position can sit in a never-sold bucket while
   * its other half was sold; this counts, per outcome, the positions with any sale at all.
   */
  outcomeWithSale: Object.fromEntries(
    Object.keys(outcomes).map((o) => [
      o,
      pos.filter((p) => p.r.mem!.outcome === o && p.r.mem!.sales > 0).length,
    ]),
  ),
  /** Positions whose collateral (or a half of it) gets the 8-hour window: not no-delay. */
  windowPositions: pos.filter((p) => p.r.delayClass !== 'no-delay').length,
  classes: Object.fromEntries(
    ['delayed', 'mixed', 'no-delay'].map((c) => [
      c,
      pos.filter((p) => p.r.delayClass === c).length,
    ]),
  ),
  neverSold: {
    positions: neverSold.length,
    debtUsd: r2(sum(neverSold.filter((p) => p.priced).map((p) => p.r.debtUsd!))),
    realRepaidUsd: r2(sum(neverSold.map((p) => p.real))),
  },
  protocolSecondsGranted: 0,
  membraneSecondsGranted: CURE_WINDOW_SECONDS,
  cure: {
    definition:
      'Price only, the same definition as the old builder (scripts/build-evidence.ts): the position’s LTV at every minute from t0 to t0 + 8h (or the data end), its whole t0 composition with every leg on its own protocol-oracle path, against its own line. Cured = the lowest LTV in that span is at or under the line; minutes = when that lowest LTV is reached; healthy at 8h = the LTV at the last minute is at or under the line. A position with no window (stablecoin collateral, or a line above 90%) is never counted cured. It ignores the band and re-arming: it is a diagnostic, and no dollar is computed from it.',
    ...cureSummary(pos),
    byProtocol: {
      'aave-v3': cureSummary(byProtocol('aave-v3')),
      'morpho-blue': cureSummary(byProtocol('morpho-blue')),
    },
    noDelay: {
      accounts: noWin.length,
      wouldHaveCuredWithWindow: noWin.filter((p) => p.probe.cure!.wouldHaveCuredWithWindow).length,
    },
  },
  oneRepay,
  freshPrints: {
    chain: 'mainnet',
    symbol: 'WETH',
    source: 'AaveOracle (Aave V3 Core, mainnet), price in force at each minute start',
    minutes: freshWethMinutes,
    gridMinutes: W.minutes,
  },
  bandSensitivity,
  sensitivity: {
    noEarlyClear: {
      rule: 'Nobody calls the permissionless clear: a return under the line does not stop the timer, so a delay that started runs to its expiry or its band break (DelayTimer noEarlyClear).',
      ...served(noEarlyClear),
    },
    noDebtFloor: {
      rule: 'The $2,000 liqDebtMinimum floor is not applied: every sale is the bare repay to cap.',
      ...served(noDebtFloor),
    },
    singleSale: {
      rule: 'At most one sale per position: the walk stops after the first repay to cap (headline: up to 20).',
      ...served(singleSale),
    },
    noWalkOnAfterT0BandSale: {
      rule: M.sensitivity.noWalkOnAfterT0BandSale.rule,
      ...served(noWalkOn),
    },
    t0PriceBasis: {
      rule: M.sensitivity.t0PriceBasis.rule,
      ...served(nm1First),
      positionsDecisionDiffers: M.sensitivity.t0PriceBasis.positionsDecisionDiffers,
    },
  },
}
if (cured.length + cur.filter((p) => !p.probe.cure!.curedInWindow).length !== cur.length) {
  fail('cure partition')
}
void healthy

// ---- by collateral asset (the largest leg at t0) ----------------------------------------------
const assetGroups = new Map<string, Pos[]>()
for (const p of pos) {
  const k = p.r.primarySymbol
  assetGroups.set(k, [...(assetGroups.get(k) ?? []), p])
}
const ASSET_MIN = 20
const byAsset = [...assetGroups.entries()]
  .filter(([, ps]) => ps.length >= ASSET_MIN)
  .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
  .map(([symbol, ps]) => {
    const mb = medianBlock(ps)
    // The old builder's denominator: every position with a cure record, a no-window one
    // counted not cured (scripts/build-evidence.ts byAsset).
    const c = ps.filter((p) => p.probe.cure)
    return {
      symbol,
      positions: ps.length,
      aave: ps.filter((p) => p.r.protocol === 'aave-v3').length,
      morpho: ps.filter((p) => p.r.protocol === 'morpho-blue').length,
      realRepaidUsd: r2(sum(ps.map((p) => p.real))),
      realShare: shareFigures(ps.map((p) => p.r)).realShare,
      memShare: shareFigures(ps.map((p) => p.r)).memShare,
      realMedianFrac: mb.realMedianFrac,
      memMedianFrac: mb.memMedianFrac,
      curedPct: c.length
        ? pct2(c.filter((p) => p.probe.cure!.curedInWindow).length / c.length)
        : null,
    }
  })

// ---- the landing figures (facts.ts reads these; nothing there is typed by hand) --------------
const under = priced.filter((p) => p.r.debtUsd! < FLOOR)
const mid = priced.filter((p) => p.r.debtUsd! >= FLOOR && p.r.debtUsd! < 2 * FLOOR)
const over = priced.filter((p) => p.r.debtUsd! >= 2 * FLOOR)
const closesWhole = (p: Pos) => p.memFrac != null && p.memFrac >= 0.9999
const moreRows = priced.filter((p) => p.cmp === 'more')
const moreUnder = moreRows.filter((p) => p.r.debtUsd! < FLOOR)
const moreOver = moreRows.filter((p) => p.r.debtUsd! >= FLOOR)
const moreOverOutcomes = outcomeCount(moreOver)
const brackets = {
  underFloor: {
    positions: under.length,
    realMedianFrac: r5(median(under.map((p) => p.realFrac!))),
    memMedianFrac: r5(median(under.map((p) => p.memFrac!))),
  },
  floorToTwice: {
    positions: mid.length,
    memClosesWhole: mid.filter(closesWhole).length,
    realMedianFrac: r5(median(mid.map((p) => p.realFrac!))),
  },
  twiceFloorUp: {
    positions: over.length,
    realMedianFrac: r5(median(over.map((p) => p.realFrac!))),
    memMedianFrac: r5(median(over.map((p) => p.memFrac!))),
  },
}
const membraneMore = {
  positions: moreRows.length,
  underFloor: {
    positions: moreUnder.length,
  },
  atOrAboveFloor: {
    positions: moreOver.length,
    outcomes: moreOverOutcomes,
    realMedianFrac: r5(median(moreOver.map((p) => p.realFrac!))),
    memMedianFrac: r5(median(moreOver.map((p) => p.memFrac!))),
  },
}
const unpricedRows = pos.filter((p) => !p.priced)
const unpriced = {
  positions: unpricedRows.length,
  loanSymbols: [...new Set(unpricedRows.map((p) => p.r.debt[0]?.symbol ?? '?'))].sort(),
  realEvents: M.totals.all.realWalked.unpricedEvents,
  memSales: M.totals.all.mem.unpricedSales,
}

// ---- meta -----------------------------------------------------------------------------------------
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}
const codeCommit = git(`log -1 --format=%H -- ${CODE_PATHS.join(' ')}`)
const codeDirty = git(`status --porcelain -- ${CODE_PATHS.join(' ')}`) !== ''

const markets = (M.scope.markets as any[]).filter((m) => m.events > 0)
const xc = M.crossCheck.summary
/** "$34.69M" / "−$8.10M" / "+$0.86M" / "$33k" / "−$989": a real minus, and no "$0.00M". */
const money = (x: number, sign = false) => {
  const a = Math.abs(x)
  const body =
    a >= 1e6
      ? `$${(a / 1e6).toFixed(2)}M`
      : a >= 1e3
        ? `$${Math.round(a / 1e3)}k`
        : `$${Math.round(a)}`
  return (x < 0 ? '\u2212' : sign ? '+' : '') + body
}
/** Morpho loan tokens whose USD comes from the chain's Aave oracle path (census stats). */
const aaveOracleLoans = [
  ...new Set(
    Object.entries(M.stats.morphoLoanPricing as Record<string, { how: string }>)
      .filter(([, v]) => v.how === 'aave-oracle-path')
      .map(([k]) => k.split(':')[1]),
  ),
]
  .sort()
  .join(', ')
const meta = {
  schema: 'evidence-census/v1',
  generatedBy: 'membrane-app scripts/build-evidence-census.ts',
  source: {
    path: 'membrane-datasets oct10-2025/coverage/census.json',
    schema: M.schema,
    bytes: censusBuf.length,
    sha256: sha(censusBuf),
    builtBy: M.generatedBy,
    /** census.meta.totals as the census states them, so a test can check the rows against them. */
    totals: Object.fromEntries(
      (
        [
          ['all', M.totals.all],
          ...Object.entries(M.totals.byProtocol as Record<string, any>),
          ...Object.entries(M.totals.byProtocolChain as Record<string, any>),
        ] as [string, any][]
      ).map(([k, t]) => [
        k,
        {
          positions: t.compared,
          events: t.realWalked.events,
          realRepaidUsd: t.realWalked.repaidUsd,
          realShare: t.shares.realShare,
          memShare: t.shares.memShare,
          positionsKept: t.mem.positionsKept,
          positionsSoldAtGridEnd: t.mem.positionsSoldAtGridEnd,
        },
      ]),
    ),
    outcomes: M.outcomes,
  },
  code: {
    commit: codeCommit,
    dirty: codeDirty,
    paths: CODE_PATHS,
    note: 'The last commit that touched the code this file is computed by. Rerunning the builder with that code and the census above writes this file byte for byte.',
  },
  window: {
    from: M.window.from,
    to: '2025-10-11T23:59:00Z',
    label: '10–11 Oct 2025',
    minutes: W.minutes,
    stepSeconds: W.stepSeconds,
  },
  scope: {
    line: 'Every Aave V3 pool in the registry and every Morpho Blue market, on Ethereum, Arbitrum, Optimism and Base',
    inScope: M.scope.inScope,
    venues: markets.map((m) => ({
      chain: m.chain,
      venue: m.venue,
      name: m.name,
      events: m.events,
    })),
    outOfScope:
      'Every other chain (Avalanche alone had ' +
      `${M.scope.outOfScope.avalancheAaveV3LiquidationCalls} Aave V3 liquidations in the window), Aave V2, Spark and the other Aave forks.`,
  },
  oracle: `Every position’s line and its minute-by-minute LTV walk use its own protocol’s oracle, read on chain: each Aave V3 market’s AaveOracle and each Morpho Blue market’s own oracle, the price in force at each minute start (no look-ahead). Dollars: an Aave liquidation is valued at the liquidating block’s AaveOracle prices. A Morpho position is walked in its loan token; its dollars are the loan token at $1 for a dollar stablecoin, else that token’s Aave oracle price on the same chain at the minute start (${aaveOracleLoans}), and a loan token with neither is left out of every dollar figure.`,
  /** The COMPARED positions: every total on the page is over these. */
  positions: rows.length,
  walked: M.coverage.walked,
  /** Every position the census holds (walked or not, compared or excluded). */
  censusPositions: allRows.length,
  exclusions: {
    rule: M.exclusions.rule,
    noMembraneLine: { ...M.exclusions.noMembraneLine, top: M.exclusions.noMembraneLine.top },
    partialMembraneLine: M.exclusions.partialMembraneLine,
    noCapacity: M.exclusions.noCapacity,
  },
  line: {
    rule: M.method.line,
    source:
      'lib/position-sim/membrane.ts MEMBRANE_ASSET_LTV (modelled) and DEPLOY_LAUNCH_LTV (script/DeployFullSystem.s.sol:243-251), through lib/wavefront/membraneLine.ts — the per-wallet simulator’s own rule.',
    sizing,
  },
  liquidity: {
    rule: M.liquidity.rule,
    multiplier: M.liquidity.multiplier,
    multiplierBasis: M.liquidity.multiplierBasis,
    windowMinutes: M.liquidity.windowMinutes,
    /** Top tokens per chain by peak USD (the full table is census meta.liquidity.capacity). */
    topByChain: Object.fromEntries(
      [...new Set((M.liquidity.capacity as any[]).map((c) => c.chain as string))]
        .sort()
        .map((chain) => [
          chain,
          (M.liquidity.capacity as any[])
            .filter((c) => c.chain === chain)
            .sort((a, b) => (b.peakUsd ?? 0) - (a.peakUsd ?? 0) || (a.key < b.key ? -1 : 1))
            .slice(0, 6)
            .map((c) => ({
              symbol: c.symbol,
              capacityTokens: +Number(c.capacityTokens).toPrecision(6),
              peakUsd: c.peakUsd == null ? null : Math.round(c.peakUsd),
            })),
        ]),
    ),
    tokens: (M.liquidity.capacity as any[]).length,
    positionsShortFilled: M.liquidity.positionsShortFilled,
    unfilledAtGridEndUsd: M.liquidity.unfilledAtGridEndUsd,
    whale,
  },
  sensitivities: sensitivityTable,
  events: all.events,
  chains: [...new Set(rows.map((r) => r.chain))],
  params: {
    band: MAX_THRESHOLD_TO_DELAY,
    delaySeconds: CURE_WINDOW_SECONDS,
    borrowLtvGap: BORROW_LTV_GAP,
    liqDebtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    maxSales: MAX_SALES,
    lineMode: 'membrane',
    capacityMultiplier: CAPACITY_MULTIPLIER,
    capacityWindowMinutes: CAPACITY_WINDOW_MINUTES,
  },
  realConstants: {
    borrowLtvGapSource: 'lib/Constants.sol:30',
    repayFormulaSource: 'LiquidationEngine.sol:2204-2238',
    cureWindowSource: 'liquidation-engine/src/contract.rs:52',
    liqDebtMinimumSource: 'script/DeployFullSystem.s.sol:388 setLiqDebtMinimum(2000e18)',
    debtMinimumRuleSource: 'LiquidationEngine.sol:2241-2269 (floor + remainder guard)',
  },
  method:
    'Every position liquidated on an Aave V3 pool or a Morpho Blue market of Ethereum, Arbitrum, Optimism or Base between 00:00 UTC 10 Oct and 23:59 UTC 11 Oct 2025: ' +
    `${allRows.length.toLocaleString('en-US')} positions, of which ${rows.length.toLocaleString('en-US')} are compared. What is compared is the SHARE OF DEBT CLOSED: each side's repaid debt over its own debt at the first liquidation, debt-weighted. Only debt repaid counts: Membrane’s liquidation fee cannot be assumed, so collateral taken does not. ` +
    'The real side is every liquidation of the position in that window, measured on chain: the debt the liquidators repaid (Aave: at the liquidating block’s AaveOracle prices; Morpho: in the loan token, priced as below), over the position’s debt at the first liquidation the protocol’s own health check confirms (t0). ' +
    'Membrane’s side is the same collateral at t0 with the debt a Membrane borrower would have carried: SIZED TO MEMBRANE’S OWN LINE, debt × (Membrane line / protocol line)†: ' +
    `lower for ${sizing.scaledDown.toLocaleString('en-US')} positions; higher (up to ${sizing.maxScale}×) for the ${sizing.scaledUp} whose Membrane line is above the protocol’s (${sizing.scaledUpHoldingStables} of them hold stablecoin collateral, which Membrane lines at 0.87 against Aave’s 0.78). An unsplit position sits as far past Membrane’s line, proportionally, as it sat past the protocol’s; a split position does so per half only, each half against its own legs’ protocol line, so on ${sizing.splitsWithAHalfUnderItsLine} of the ${sizing.splits} split positions a half opens under its own line.` +
    ' Membrane’s line is the value-weighted modelled max LTV of the collateral (WETH 80%, wstETH 78%, WBTC 75%, …)†. It is walked minute by minute on each leg’s own protocol-oracle path. ' +
    'A breach inside line × 1.04 waits eight hours; a return under the line clears the timer; past the band, or still over the line at expiry, the position is repaid to its borrow cap (line − 3pp) with the $2,000 floor, and it walks on. Stablecoin collateral, or a line above 90%, gets no window and is repaid the minute it is over its line†. A position holding both is split the way Membrane would hold it, each half sized to its own line. ' +
    `Every sale is LIQUIDITY-CAPPED: all of Membrane’s sales of a token on a chain share ${CAPACITY_MULTIPLIER}×† (${MULTIPLIER_BASIS}) the most tokens liquidators actually absorbed in any ${CAPACITY_WINDOW_MINUTES} minutes of the two days (Aave and Morpho together); what does not fill waits and sells in later minutes at those minutes’ prices, never past the borrow cap. ` +
    `Left out of both sides: ${M.exclusions.noMembraneLine.positions.toLocaleString('en-US')} positions whose collateral has no Membrane line (${money(M.exclusions.noMembraneLine.realRepaidUsd)} repaid by the protocols), ${M.exclusions.partialMembraneLine.positions.toLocaleString('en-US')} that hold SOME collateral without one (${money(M.exclusions.partialMembraneLine.realRepaidUsd)}), and ${M.exclusions.noCapacity.positions.toLocaleString('en-US')} that would have to sell a token nobody liquidated on that chain (${money(M.exclusions.noCapacity.realRepaidUsd)}). ` +
    `Both sides are over the same positions; the ${unpriced.positions} whose loan token has no USD price count in every position total and in no share.`,
  sameSet: M.method.sameSet,
  unpriced,
  gridEnd: {
    positions: all.gridEnd.positions,
    positionsFirstSoldThere: outcomes['sold-at-grid-end'] ?? 0,
    memShare: all.gridEnd.memShare,
    byProtocol: { 'aave-v3': aave.gridEnd, 'morpho-blue': morpho.gridEnd },
    rule: 'A position still inside its 8-hour window when the data ends (23:59 UTC 11 Oct) has not been sold: the window is still open. The census books it as sold at the last minute’s price, the conservative choice, and every Membrane total here includes that sale. It is marked wherever it appears.',
  },
  crossCheck: {
    label: 'Old census (747 rows, superseded)',
    rows: xc.rows,
    old: { realRepaidUsd: xc.real.old, memRepaidUsd: xc.membrane.old },
    new: { realRepaidUsd: xc.real.new, memRepaidUsd: xc.membrane.new },
    factors: xc.membrane.factors,
    interactionAndResidualUsd: xc.membrane.interactionAndResidual,
    allFactorsToggledUsd: xc.membrane.allFactorsToggled,
    allFactorsToggledVsOldUsd: xc.membrane.allFactorsToggledVsOld,
    line:
      `The old census priced ${xc.rows} Aave accounts and said Membrane closes ${Math.round(100 * (1 - xc.membrane.old / xc.real.old))}% less (Aave ${money(xc.real.old)}, Membrane ${money(xc.membrane.old)}). ` +
      `On the same ${xc.rows} rows this census gives ${money(xc.real.new)} and ${money(xc.membrane.new)}†. ` +
      `The Membrane side moved because the old census priced every account off mainnet Chainlink rounds: each L2 chain’s own oracle moves it ${money(xc.membrane.factors.perChainOraclesL2_iii, true)}, mainnet’s AaveOracle instead of the round log ${money(xc.membrane.factors.priceSourceMainnet_i, true)}, the full composition instead of the liquidated leg ${money(xc.membrane.factors.composition_ii, true)}, the line ${money(xc.membrane.factors.line_iv, true)}, and the factors together another ${money(xc.membrane.interactionAndResidual, true)}. ` +
      `Switching all four back reproduces the old ${money(xc.membrane.old)} to within $${Math.abs(Math.round(xc.membrane.allFactorsToggledVsOld)).toLocaleString('en-US')}.`,
  },
  caveats: [
    'Membrane has no mainnet deployment. Everything on its side is the contract’s rules run against the day’s real prices†, not a measurement of a live protocol.',
    `${all.gridEnd.positions} positions were still inside their 8-hour window when the data ends (23:59 UTC 11 Oct). A window still open is not a completed sale; the census books each as sold at the last price, which is the conservative choice. Those sales are ${(all.gridEnd.memShare * 100).toFixed(2)}% of Membrane’s debt† and are marked in the table.`,
    `${unpriced.positions} Morpho positions borrow a token with no USD price on that day (${unpriced.loanSymbols.join(', ')}). They are walked and counted in every position total, and left out of every dollar total and median on both sides.`,
    'Only debt repaid is compared. Membrane’s liquidation fee is not assumed, so collateral taken from the borrower is not a comparison on either side.',
    'The real side can repay more than the debt at t0: a borrower can borrow again between liquidations, and interest accrues. Membrane’s walk starts from the t0 position and adds neither.',
    `Membrane’s line is modelled†: no Membrane market is deployed, and the per-asset max LTVs (WETH 80%, wstETH 78%, WBTC 75%, …) are our assumption. Each position’s debt is sized to Membrane’s line (debt × Membrane line / protocol line, per half for a split position); that sizing is modelled† too: ${sizing.scaledDown.toLocaleString('en-US')} positions carry less debt, ${sizing.scaledUp} carry more (up to ${sizing.maxScale}×), and on ${sizing.splitsWithAHalfUnderItsLine} of the ${sizing.splits} split positions a half opens under its own line. Because the two sides then carry different debt, the page compares the SHARE of each side’s own debt closed, never the dollars. ${(M.exclusions.noMembraneLine.positions + M.exclusions.partialMembraneLine.positions).toLocaleString('en-US')} positions holding any collateral without a Membrane line (${money(M.exclusions.noMembraneLine.realRepaidUsd + M.exclusions.partialMembraneLine.realRepaidUsd)} repaid by the protocols) are left out of both sides; the protocol’s-line run is published beside the headline.`,
    `Sales are capped by the liquidity the day actually showed: ${CAPACITY_MULTIPLIER}× the most tokens liquidators absorbed in any ${CAPACITY_WINDOW_MINUTES} minutes, per token and chain, shared by every Membrane sale (${CAPACITY_MULTIPLIER}×† — † ${MULTIPLIER_BASIS}). 0.5×, 1×, 1.1× (the previous headline), 2×, unlimited and the research's per-class multipliers are published. Each fill is priced at the oracle, not at a market impact price.`,
    'The timer is cleared the minute a position is back under its line. Both clearing paths are permissionless calls somebody has to make; the sensitivity where nobody does is published below.',
    'The cure column is a price-only diagnostic: it ignores the band and re-arming, and no dollar is computed from it.',
    'The result is path-dependent. 10 Oct was a sharp wick with a partial recovery; a market that keeps falling would not cure.',
    'Out of scope: every chain other than Ethereum, Arbitrum, Optimism and Base, and every lending venue other than Aave V3 and Morpho Blue (Aave V2, Spark and the Aave forks).',
  ],
}

// ---- the rows (columnar) ---------------------------------------------------------------------------
const COLUMNS = [
  'protocol',
  'chain',
  'market',
  'owner',
  'marketId',
  'events',
  't0Minute',
  'coll',
  'debt',
  'collUsd',
  'debtUsd',
  'line',
  'protocolLine',
  'ltv0',
  'delayClass',
  'primary',
  'cluster',
  'priced',
  'realRepaidUsd',
  'realBadDebtUsd',
  'memDebtUsd',
  'memRepaidUsd',
  'memUnlimitedUsd',
  'realFrac',
  'memFrac',
  'outcome',
  'sales',
  'firstSaleMinute',
  'gridEndUsd',
  'minutesToFirstCure',
  'oneRepayUsd',
  'cure',
] as const
const legsOut = (xs: CensusRow['collateral']) =>
  [...xs]
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (a.symbol < b.symbol ? -1 : 1))
    .map((l) => [l.symbol, l.usd == null ? null : r2(l.usd)])
const cohort = pos.map((p) => {
  const r = p.r
  const c = p.probe.cure
  const row: Record<(typeof COLUMNS)[number], unknown> = {
    protocol: r.protocol === 'aave-v3' ? 'aave' : 'morpho',
    chain: r.chain,
    market: r.marketLabel,
    owner: r.owner,
    marketId: r.protocol === 'morpho-blue' ? r.market : null,
    events: r.events,
    t0Minute: r.t0!.minute,
    coll: legsOut(r.collateral),
    debt: legsOut(r.debt),
    collUsd: r.collUsd == null ? null : r2(r.collUsd),
    debtUsd: r.debtUsd == null ? null : r2(r.debtUsd),
    line: r5(r.memLine ? r.memLine.line : r.line!),
    protocolLine: r5(r.line!),
    ltv0: r5(r.ltv0!),
    delayClass: r.delayClass,
    primary: r.primarySymbol,
    cluster: r.cluster,
    priced: p.priced ? 1 : 0,
    realRepaidUsd: r2(p.real),
    realBadDebtUsd: r2(r.real.badDebtUsd),
    memDebtUsd: r.mem!.debt0Usd == null ? null : r2(r.mem!.debt0Usd),
    memRepaidUsd: r2(p.mem),
    memUnlimitedUsd: r2(memUnl(p)),
    realFrac: p.realFrac == null ? null : r5(p.realFrac),
    memFrac: p.memFrac == null ? null : r5(p.memFrac),
    outcome: r.mem!.outcome,
    sales: r.mem!.sales,
    firstSaleMinute: r.mem!.firstSaleMinute,
    gridEndUsd: r.mem!.armedAtGridEnd ? r2(p.gridEnd) : null,
    minutesToFirstCure: p.probe.minutesToFirstCure,
    oneRepayUsd: p.probe.oneRepayUsd == null ? null : r2(p.probe.oneRepayUsd),
    cure: c
      ? [
          c.curedInWindow ? 1 : 0,
          c.healthyAt8h ? 1 : 0,
          c.minutesToCure,
          c.bestLtv,
          c.endLtv,
          c.noWindow ? 1 : 0,
          c.wouldHaveCuredWithWindow ? 1 : 0,
        ]
      : null,
  }
  return COLUMNS.map((k) => row[k])
})

const debt = { all, byProtocol: { 'aave-v3': aave, 'morpho-blue': morpho }, byVenueChain }
const landing = {
  brackets,
  membraneMore,
  // Summed on the published cents, so the cohort's own rows re-derive it exactly.
  collateralAtRiskUsd: r2(sum(priced.map((p) => r2(p.r.collUsd!)))),
}
const doc = {
  meta,
  debt,
  time,
  byAsset,
  landing,
  cohort: {
    columns: COLUMNS,
    cureColumns: [
      'curedInWindow',
      'healthyAt8h',
      'minutesToCure',
      'bestLtv',
      'endLtv',
      'noWindow',
      'wouldHaveCuredWithWindow',
    ],
    legColumns: ['symbol', 'usdAtT0'],
    rows: cohort,
  },
}

// ---- the headline file: what the landing imports without fetching the cohort -----------------
type ShareSet = ReturnType<typeof shareFigures>
const pick = (f: ShareSet) => ({
  positions: f.positions,
  pricedPositions: f.pricedPositions,
  realRepaidUsd: f.realRepaidUsd,
  realShare: f.realShare,
  memShare: f.memShare,
  gapPp: f.gapPp,
})
const setBrief = (s: typeof all) => ({
  ...pick(s),
  less: s.less,
  more: s.more,
  equal: s.equal,
  lessSet: s.lessSet,
  moreSet: s.moreSet,
  medians: s.medians.all,
})
const headlineDoc = {
  source:
    'Generated by scripts/build-evidence-census.ts with public/data/oct10-2025/evidence-census.json; do not hand-edit. tests/unit/oct10Totals.test.ts checks every field against that file.',
  censusSha256: meta.source.sha256,
  window: meta.window.label,
  scope: meta.scope.line,
  /** The COMPARED positions (both sides); censusPositions is every position the census holds. */
  positions: meta.positions,
  censusPositions: meta.censusPositions,
  sizing: {
    scaledDown: sizing.scaledDown,
    scaledUp: sizing.scaledUp,
    scaledUpHoldingStables: sizing.scaledUpHoldingStables,
    maxScale: sizing.maxScale,
    splits: sizing.splits,
    splitsWithAHalfUnderItsLine: sizing.splitsWithAHalfUnderItsLine,
  },
  excluded: {
    noMembraneLine: {
      positions: M.exclusions.noMembraneLine.positions,
      realRepaidUsd: M.exclusions.noMembraneLine.realRepaidUsd,
    },
    partialMembraneLine: {
      positions: M.exclusions.partialMembraneLine.positions,
      realRepaidUsd: M.exclusions.partialMembraneLine.realRepaidUsd,
    },
    noCapacity: {
      positions: M.exclusions.noCapacity.positions,
      realRepaidUsd: M.exclusions.noCapacity.realRepaidUsd,
    },
  },
  capacityMultiplier: CAPACITY_MULTIPLIER,
  /** THE SIZE OF THE DAY (the real side only, every position of the census): the stakes line. */
  day: {
    positions: allRows.length,
    events: sum(allRows.map((r) => r.real.events)),
    realRepaidUsd: r2(sum(allRows.map((r) => r.real.repaidUsd))),
  },
  events: meta.events,
  chains: meta.chains,
  /** Shares of each side's own t0 debt closed (debt-weighted, priced positions). */
  all: setBrief(all),
  aave: setBrief(aave),
  morpho: setBrief(morpho),
  unpricedPositions: unpriced.positions,
  gridEnd: { positions: meta.gridEnd.positions, memShare: all.gridEnd.memShare },
  neverSold: time.neverSold,
  concentration: {
    top1GapPp: all.concentration.top5[0].gapPp,
    top1Protocol: all.concentration.top5[0].protocol,
    top1Chain: all.concentration.top5[0].chain,
    top1Owner: all.concentration.top5[0].owner,
    top1Outcome: all.concentration.top5[0].outcome,
    gapWithoutTop1Pp: all.concentration.gapWithoutTop1Pp,
    top5Share: all.concentration.top5Share,
    gapWithoutTop5Pp: all.concentration.gapWithoutTop5Pp,
  },
  brackets,
  membraneMore,
  sensitivity: {
    /** The whole published table, each row on its own compared set, with the split. */
    table: sensitivityTable.map((r) => ({
      key: r.key,
      label: r.label,
      headline: r.headline,
      ...pick(r),
      aave: pick(r.byProtocol['aave-v3']),
      morpho: pick(r.byProtocol['morpho-blue']),
    })),
  },
}

// ---- print & write ---------------------------------------------------------------------------------
const json = JSON.stringify(doc) + '\n'
const headJson = JSON.stringify(headlineDoc, null, 1) + '\n'
const m = (x: number) => `$${(x / 1e6).toFixed(2)}M`
console.log(
  `census ${meta.source.sha256.slice(0, 12)} · ${rows.length} positions · code ${codeCommit.slice(0, 10)}${codeDirty ? ' (dirty)' : ''}`,
)
const pc = (x: number) => `${(x * 100).toFixed(1)}%`
for (const s of [all, aave, morpho]) {
  console.log(
    `  ${s.key.padEnd(12)} ${String(s.positions).padStart(5)} (priced ${s.pricedPositions})  real ${pc(s.realShare)} of ${m(s.realDebtUsd)}  mem ${pc(s.memShare)}† of ${m(s.memDebtUsd)}  gap ${s.gapPp}pp  less/more/equal ${s.less}/${s.more}/${s.equal} (less: ${pc(s.lessSet.realShare)} vs ${pc(s.lessSet.memShare)}; more: ${pc(s.moreSet.realShare)} vs ${pc(s.moreSet.memShare)})  medians ${s.medians.all.realMedianFrac}/${s.medians.all.memMedianFrac}  size of day ${m(s.realRepaidUsd)}`,
  )
}
console.log('  outcomes', JSON.stringify(outcomes))
console.log('  cure', JSON.stringify({ ...cureSummary(pos), noDelay: time.cure.noDelay }))
console.log('  one repay', JSON.stringify(oneRepay))
for (const r of sensitivityTable) {
  const A = r.byProtocol['aave-v3']
  const B = r.byProtocol['morpho-blue']
  console.log(
    `  sens ${r.key.padEnd(30)} ${String(r.positions).padStart(5)}  real ${pc(r.realShare)}  mem ${pc(r.memShare)}  gap ${r.gapPp}pp  l/m/e ${r.less}/${r.more}/${r.equal} | aave ${A.positions} ${pc(A.realShare)}→${pc(A.memShare)} (${A.gapPp}pp) | morpho ${B.positions} ${pc(B.realShare)}→${pc(B.memShare)} (${B.gapPp}pp)`,
  )
}
console.log('  whale', JSON.stringify(whale))
console.log('  grid end', JSON.stringify(meta.gridEnd))
console.log('  fresh WETH minutes', freshWethMinutes)
console.log('  concentration', JSON.stringify({ ...all.concentration, top5: undefined }))
console.log('  landing', JSON.stringify(landing))
console.log(
  `  size ${Buffer.byteLength(json).toLocaleString('en-US')} B (headline ${Buffer.byteLength(headJson)} B)`,
)
if (NO_WRITE) process.exit(0)
fs.writeFileSync(OUT, json)
fs.writeFileSync(OUT_HEADLINE, headJson)
console.log(`wrote ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, OUT_HEADLINE)}`)
