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
import { kernelLegs, type PositionSpec } from '../lib/wavefront/aave'
import type { KernelLeg } from '../lib/wavefront/kernel'
import {
  CAPACITY_MULTIPLIER,
  CAPACITY_WINDOW_MINUTES,
  RESEARCH_FLOW_READING_MULTIPLIER,
  RESEARCH_LIQUIDITY_CLASSES,
} from '../lib/wavefront/liquidity'
import { AAVE_CORE_POOL } from '../lib/wavefront/pid'
import { datasetsDir } from './lib/datasetsDir.mjs'
import {
  buildCensus,
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
  const ltv0 = s.ltv0 as number

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
type ProtoTotals = { all: number; 'aave-v3': number; 'morpho-blue': number }
const memTotals = (rs: readonly CensusRow[]): ProtoTotals => {
  const t: ProtoTotals = { all: 0, 'aave-v3': 0, 'morpho-blue': 0 }
  for (const r of rs) {
    const v = r.mem?.repaidUsd ?? 0
    t.all += v
    t[r.protocol] += v
  }
  return { all: r2(t.all), 'aave-v3': r2(t['aave-v3']), 'morpho-blue': r2(t['morpho-blue']) }
}
const headlineMem = memTotals(rows)
/** Both sides, gross less / more and the counts, over a run's own compared set. */
function setFigures(rs: readonly CensusRow[]) {
  const cmp = rs.filter((r) => r.mem)
  const priced = (r: CensusRow) =>
    r.debtUsd != null &&
    r.collUsd != null &&
    r.real.unpricedEvents === 0 &&
    r.mem!.unpricedSales === 0
  const one = (xs: CensusRow[]) => {
    const real = sum(xs.map((r) => r.real.repaidUsd))
    const mem = sum(xs.map((r) => r.mem!.repaidUsd))
    const p = xs.filter(priced)
    const less = p.filter((r) => r2(r.mem!.repaidUsd) < r2(r.real.repaidUsd))
    const more = p.filter((r) => r2(r.mem!.repaidUsd) > r2(r.real.repaidUsd))
    return {
      positions: xs.length,
      realRepaidUsd: r2(real),
      memRepaidUsd: r2(mem),
      gapUsd: r2(real - mem),
      gapPct: real > 0 ? pct2((real - mem) / real) : 0,
      less: less.length,
      more: more.length,
      lessUsd: r2(sum(less.map((r) => r.real.repaidUsd - r.mem!.repaidUsd))),
      moreUsd: r2(sum(more.map((r) => r.mem!.repaidUsd - r.real.repaidUsd))),
    }
  }
  return {
    ...one(cmp),
    byProtocol: {
      'aave-v3': one(cmp.filter((r) => r.protocol === 'aave-v3')),
      'morpho-blue': one(cmp.filter((r) => r.protocol === 'morpho-blue')),
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
function sensitivity(key: string, opts: CensusOptions) {
  const res = buildCensus(inputs, opts)
  sensRuns.set(key, res.rows)
  const byPid = new Map(allRows.map((r) => [r.pid, r]))
  const changed = res.rows.filter(
    (r) => Math.abs((r.mem?.repaidUsd ?? 0) - (byPid.get(r.pid)!.mem?.repaidUsd ?? 0)) > 0.005,
  ).length
  const f = setFigures(res.rows)
  return {
    memRepaidUsd: f.memRepaidUsd,
    byProtocol: {
      'aave-v3': f.byProtocol['aave-v3'].memRepaidUsd,
      'morpho-blue': f.byProtocol['morpho-blue'].memRepaidUsd,
    },
    deltaUsd: r2(headlineMem.all - f.memRepaidUsd),
    positionsChanged: changed,
    set: f,
  }
}
const headlineSet = setFigures(allRows)
const bands = [0.02, MAX_THRESHOLD_TO_DELAY, 0.08]
const bandSensitivity = bands.map((band) => {
  if (band === MAX_THRESHOLD_TO_DELAY) {
    return {
      band,
      memRepaidUsd: headlineMem.all,
      byProtocol: { 'aave-v3': headlineMem['aave-v3'], 'morpho-blue': headlineMem['morpho-blue'] },
      set: headlineSet,
    }
  }
  const s = sensitivity(`band${band}`, { band })
  return { band, memRepaidUsd: s.memRepaidUsd, byProtocol: s.byProtocol, set: s.set }
})
const noEarlyClear = sensitivity('noEarlyClear', { noEarlyClear: true })
const noDebtFloor = sensitivity('noDebtFloor', { noDebtFloor: true })
const singleSale = sensitivity('singleSale', { maxSales: 1 })
// The census's own two sensitivities, rerun here so each carries its per-protocol split; the
// totals must be the ones census.json publishes.
const noWalkOn = sensitivity('noWalkOn', { stopAfterT0BandSale: true })
const nm1First = sensitivity('nm1First', { basisOrder: ['N-1', 'N'] })
if (Math.abs(noWalkOn.memRepaidUsd - M.sensitivity.noWalkOnAfterT0BandSale.memRepaidUsd) > 0.011) {
  fail('noWalkOnAfterT0BandSale rerun differs from census.json')
}
if (
  Math.abs(nm1First.memRepaidUsd - M.sensitivity.t0PriceBasis.wholeCensusAtNm1FirstMemRepaidUsd) >
  0.011
) {
  fail('t0PriceBasis rerun differs from census.json')
}
// THE LIQUIDITY CAP AND THE LINE (owner ruling 2026-10-18).
const MULTIPLIERS = [0.5, 1.0, CAPACITY_MULTIPLIER, 2.0, Infinity]
const capacityRuns = MULTIPLIERS.map((m) => {
  if (m === CAPACITY_MULTIPLIER) return { multiplier: m, set: headlineSet }
  const s = sensitivity(`cap${m}`, { capacityMultiplier: m })
  return { multiplier: m, set: s.set }
})
const unlimitedRows = sensRuns.get('capInfinity')!
// The liquidity-recovery research (membrane-datasets q28/liquidity-recovery REPORT.md):
// per-class multipliers, and the literal absorbed-flow reading at 0.2x everywhere.
const researchPerClass = sensitivity('capResearch', { capacityMultiplier: 'research-per-class' })
const researchFlow = sensitivity('capFlow', {
  capacityMultiplier: RESEARCH_FLOW_READING_MULTIPLIER,
})
for (const r of [researchPerClass, researchFlow]) {
  if (r.set.positions !== headlineSet.positions) fail('a research run is not on the headline set')
}
const protocolLine = sensitivity('protocolLine', { lineMode: 'protocol' })
const protocolLineUnlimited = sensitivity('protocolLineUnlimited', {
  lineMode: 'protocol',
  capacityMultiplier: Infinity,
})
const strictLines = sensitivity('strictLines', { strictLines: true })
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
      capLabel(c.multiplier) + (c.multiplier === CAPACITY_MULTIPLIER ? ' (headline)' : ''),
      c.multiplier === Infinity
        ? 'Every sale fills at once at the oracle price, in any size: the assumption before 2026-10-18. Same positions as the headline.'
        : `Membrane's sales of a token on a chain share ${c.multiplier}x the most tokens liquidators absorbed in any rolling ${CAPACITY_WINDOW_MINUTES} minutes of the window.`,
      c.set,
      c.multiplier === CAPACITY_MULTIPLIER,
    ),
  ),
  sensRow(
    'capacity-research-per-class',
    'research per-class capacity',
    `The liquidity-recovery research's class multipliers on the 10-minute capacity: ${RESEARCH_LIQUIDITY_CLASSES.map((c) => `${c.label} ${c.multiplier}x`).join(', ')} (lib/wavefront/liquidity.ts RESEARCH_LIQUIDITY_CLASSES). Same positions as the headline.`,
    researchPerClass.set,
  ),
  sensRow(
    'capacity-research-flow',
    `research per-class + flow reading (${RESEARCH_FLOW_READING_MULTIPLIER}x everywhere)`,
    `The literal reading of absorbed flow: ${RESEARCH_FLOW_READING_MULTIPLIER}x the 10-minute capacity for every token. Same positions as the headline.`,
    researchFlow.set,
  ),
  sensRow(
    'protocol-line',
    "Membrane at the protocol's own line, 1.1x capacity",
    "Each position walked at its protocol's line (Aave weighted LT, Morpho LLTV) instead of Membrane's; positions with no Membrane line are back in. Its own compared set.",
    protocolLine.set,
  ),
  sensRow(
    'protocol-line-unlimited',
    "Membrane at the protocol's own line, unlimited",
    'The census before 2026-10-18 (its 157.06M), less the positions that would have to sell a token with no observed liquidity.',
    protocolLineUnlimited.set,
  ),
  sensRow(
    'strict-lines',
    'Strict lines, 1.1x capacity',
    'A position with ANY collateral leg that has no Membrane line is excluded too (the headline leaves those legs out of the weighted line).',
    strictLines.set,
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
    ? { memRepaidUsd: r.mem ? r2(r.mem.repaidUsd) : null, excluded: r.excluded ?? null }
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
  mem: number
  realFrac: number | null
  memFrac: number | null
  cmp: 'less' | 'more' | 'equal' | 'unpriced'
  probe: Probed
  gridEnd: number
}
const debtUnits = (r: CensusRow) =>
  r.protocol === 'aave-v3' ? (r.debtUsd ?? 0) : sum(r.debt.map((l) => l.amount))
const pos: Pos[] = rows.map((r) => {
  const mem = r.mem!
  const priced =
    r.debtUsd != null && r.collUsd != null && r.real.unpricedEvents === 0 && mem.unpricedSales === 0
  const real = r.real.repaidUsd
  const m = mem.repaidUsd
  const du = debtUnits(r)
  // Compared on the published cents: two sums of the same 2-dp sale records can differ by
  // float noise (1e-12), which is not a difference anyone could see or spend.
  const cmp: Pos['cmp'] = !priced
    ? 'unpriced'
    : r2(m) < r2(real)
      ? 'less'
      : r2(m) > r2(real)
        ? 'more'
        : 'equal'
  return {
    r,
    priced,
    real,
    mem: m,
    realFrac: priced && r.debtUsd! > 0 ? real / r.debtUsd! : null,
    memFrac: priced && du > 0 ? mem.closedT0 / du : null,
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
function concentration(ps: readonly Pos[], gap: number, real: number) {
  const g = ps
    .filter((p) => p.priced)
    .map((p) => ({ p, gap: p.real - p.mem }))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || (a.p.r.pid < b.p.r.pid ? -1 : 1))
  const abs = sum(g.map((x) => Math.abs(x.gap)))
  const top = (n: number) => g.slice(0, n)
  const without = (n: number) => gap - sum(top(n).map((x) => x.gap))
  const brief = (x: { p: Pos; gap: number }) => ({
    pid: x.p.r.pid,
    protocol: x.p.r.protocol,
    chain: x.p.r.chain,
    owner: x.p.r.owner,
    gapUsd: r2(x.gap),
    realRepaidUsd: r2(x.p.real),
    memRepaidUsd: r2(x.p.mem),
    outcome: x.p.r.mem!.outcome,
  })
  return {
    shareDenominator: 'sum over positions of |real - Membrane|',
    gapAbsoluteUsd: r2(abs),
    gapPositiveUsd: r2(sum(g.filter((x) => x.gap > 0).map((x) => x.gap))),
    gapNegativeUsd: r2(sum(g.filter((x) => x.gap < 0).map((x) => x.gap))),
    top1Share: abs > 0 ? r4(Math.abs(g[0].gap) / abs) : 0,
    top5Share: abs > 0 ? r4(sum(top(5).map((x) => Math.abs(x.gap))) / abs) : 0,
    top5: top(5).map(brief),
    gapWithoutTop1Usd: r2(without(1)),
    gapWithoutTop1Pct: real > 0 ? pct2(without(1) / (real - (g[0]?.p.real ?? 0))) : 0,
    gapWithoutTop5Usd: r2(without(5)),
    gapWithoutTop5Pct: real > 0 ? pct2(without(5) / (real - sum(top(5).map((x) => x.p.real)))) : 0,
  }
}
function debtSet(key: string, label: string, ps: readonly Pos[]) {
  const real = sum(ps.map((p) => p.real))
  const mem = sum(ps.map((p) => p.mem))
  const gap = real - mem
  const ge = ps.filter((p) => p.r.mem!.armedAtGridEnd)
  return {
    key,
    label,
    positions: ps.length,
    pricedPositions: ps.filter((p) => p.priced).length,
    unpricedPositions: ps.filter((p) => !p.priced).length,
    events: sum(ps.map((p) => p.r.real.events)),
    realRepaidUsd: r2(real),
    realBadDebtUsd: r2(sum(ps.map((p) => p.r.real.badDebtUsd))),
    memRepaidUsd: r2(mem),
    gapUsd: r2(gap),
    gapPct: real > 0 ? pct2(gap / real) : 0,
    less: ps.filter((p) => p.cmp === 'less').length,
    more: ps.filter((p) => p.cmp === 'more').length,
    equal: ps.filter((p) => p.cmp === 'equal').length,
    /** Gross, on the same per-position rule as less / more: what the net gap is made of. */
    lessUsd: r2(sum(ps.filter((p) => p.cmp === 'less').map((p) => p.real - p.mem))),
    moreUsd: r2(sum(ps.filter((p) => p.cmp === 'more').map((p) => p.mem - p.real))),
    memNeverSold: ps.filter((p) => p.r.mem!.sales === 0).length,
    gridEnd: {
      positions: ge.length,
      memRepaidUsd: r2(sum(ge.map((p) => p.gridEnd))),
    },
    medians: {
      all: medianBlock(ps),
      atLeastFloor: medianBlock(ps.filter((p) => (p.r.debtUsd ?? 0) >= FLOOR)),
      floorUsd: FLOOR,
    },
    concentration: concentration(ps, gap, real),
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
close(all.memRepaidUsd, M.totals.all.mem.repaidUsd, 'Membrane repaid')
for (const [k, s] of [
  ['aave-v3', aave],
  ['morpho-blue', morpho],
] as const) {
  close(s.realRepaidUsd, M.totals.byProtocol[k].realWalked.repaidUsd, `${k} real repaid`)
  close(s.memRepaidUsd, M.totals.byProtocol[k].mem.repaidUsd, `${k} Membrane repaid`)
  if (s.positions !== M.totals.byProtocol[k].compared) fail(`${k} positions`)
}
for (const v of byVenueChain) {
  const t = M.totals.byProtocolChain[v.key]
  if (!t) fail(`no census total for ${v.key}`)
  close(v.realRepaidUsd, t.realWalked.repaidUsd, `${v.key} real repaid`)
  close(v.memRepaidUsd, t.mem.repaidUsd, `${v.key} Membrane repaid`)
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
      ...noEarlyClear,
    },
    noDebtFloor: {
      rule: 'The $2,000 liqDebtMinimum floor is not applied: every sale is the bare repay to cap.',
      ...noDebtFloor,
    },
    singleSale: {
      rule: 'At most one sale per position: the walk stops after the first repay to cap (headline: up to 20).',
      ...singleSale,
    },
    noWalkOnAfterT0BandSale: {
      rule: M.sensitivity.noWalkOnAfterT0BandSale.rule,
      ...noWalkOn,
    },
    t0PriceBasis: {
      rule: M.sensitivity.t0PriceBasis.rule,
      ...nm1First,
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
      memRepaidUsd: r2(sum(ps.map((p) => p.mem))),
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
    extraUsd: r2(sum(moreUnder.map((p) => p.mem - p.real))),
  },
  atOrAboveFloor: {
    positions: moreOver.length,
    extraUsd: r2(sum(moreOver.map((p) => p.mem - p.real))),
    outcomes: moreOverOutcomes,
    realMedianFrac: r5(median(moreOver.map((p) => p.realFrac!))),
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
          memRepaidUsd: t.mem.repaidUsd,
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
    noCapacity: M.exclusions.noCapacity,
    partialLine: M.exclusions.partialLine,
  },
  line: {
    rule: M.method.line,
    source:
      'lib/position-sim/membrane.ts MEMBRANE_ASSET_LTV (modelled) and DEPLOY_LAUNCH_LTV (script/DeployFullSystem.s.sol:243-251), through lib/wavefront/membraneLine.ts — the per-wallet simulator’s own rule.',
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
    `${allRows.length.toLocaleString('en-US')} positions, of which ${rows.length.toLocaleString('en-US')} are compared. Only DEBT REPAID is compared: Membrane’s liquidation fee cannot be assumed, so collateral taken is not. ` +
    'The real side is every liquidation of the position in that window, measured on chain: the debt the liquidators repaid (Aave: at the liquidating block’s AaveOracle prices; Morpho: in the loan token, priced as below). ' +
    'Membrane’s side starts from the same position at the first liquidation the protocol’s own health check confirms (t0), with its whole composition read the block before, and walks it minute by minute on each leg’s own protocol-oracle path, at MEMBRANE’S OWN LINE: the value-weighted modelled max LTV of its collateral (WETH 80%, wstETH 78%, WBTC 75%, …)†, lower than most protocol lines, so a position is further past its line at t0. ' +
    'A breach inside line × 1.04 waits eight hours; a return under the line clears the timer; past the band, or still over the line at expiry, the position is repaid to its borrow cap (line − 3pp) with the $2,000 floor, and it walks on. Stablecoin collateral, or a line above 90%, gets no window and is repaid the minute it is over its line†. A position holding both is split the way Membrane would hold it. ' +
    `Every sale is LIQUIDITY-CAPPED†: all of Membrane’s sales of a token on a chain share ${CAPACITY_MULTIPLIER}× the most tokens liquidators actually absorbed in any ${CAPACITY_WINDOW_MINUTES} minutes of the two days (Aave and Morpho together); what does not fill waits and sells in later minutes at those minutes’ prices, never past the borrow cap. ` +
    `Left out of both sides: ${M.exclusions.noMembraneLine.positions.toLocaleString('en-US')} positions whose collateral has no Membrane line (${money(M.exclusions.noMembraneLine.realRepaidUsd)} repaid by the protocols) and ${M.exclusions.noCapacity.positions.toLocaleString('en-US')} that would have to sell a token nobody liquidated on that chain (${money(M.exclusions.noCapacity.realRepaidUsd)}). ` +
    `Both sides are summed over the same positions; the ${unpriced.positions} whose loan token has no USD price count in every position total and in no dollar total.`,
  sameSet: M.method.sameSet,
  unpriced,
  gridEnd: {
    positions: all.gridEnd.positions,
    positionsFirstSoldThere: outcomes['sold-at-grid-end'] ?? 0,
    memRepaidUsd: all.gridEnd.memRepaidUsd,
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
    `${all.gridEnd.positions} positions were still inside their 8-hour window when the data ends (23:59 UTC 11 Oct). A window still open is not a completed sale; the census books each as sold at the last price, which is the conservative choice. Those sales are ${money(all.gridEnd.memRepaidUsd)} of Membrane’s total† and are marked in the table.`,
    `${unpriced.positions} Morpho positions borrow a token with no USD price on that day (${unpriced.loanSymbols.join(', ')}). They are walked and counted in every position total, and left out of every dollar total and median on both sides.`,
    'Only debt repaid is compared. Membrane’s liquidation fee is not assumed, so collateral taken from the borrower is not a comparison on either side.',
    'The real side can repay more than the debt at t0: a borrower can borrow again between liquidations, and interest accrues. Membrane’s walk starts from the t0 position and adds neither.',
    `Membrane’s line is modelled†: no Membrane market is deployed, and the per-asset max LTVs (WETH 80%, wstETH 78%, WBTC 75%, …) are our assumption. Most are below the protocols’ own lines, so the same position is further past Membrane’s line at the first liquidation and is repaid further down. ${M.exclusions.noMembraneLine.positions.toLocaleString('en-US')} positions whose collateral has no Membrane line (${money(M.exclusions.noMembraneLine.realRepaidUsd)} repaid by the protocols) are left out of both sides; the protocol’s-line run is published beside the headline.`,
    `Sales are capped by the liquidity the day actually showed: ${CAPACITY_MULTIPLIER}× the most tokens liquidators absorbed in any ${CAPACITY_WINDOW_MINUTES} minutes, per token and chain, shared by every Membrane sale. The 1.1× is a modelled assumption† (the delay lets some liquidity recover); 0.5×, 1×, 2× and unlimited are published. Each fill is priced at the oracle, not at a market impact price.`,
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
const setPick = (f: {
  positions: number
  realRepaidUsd: number
  memRepaidUsd: number
  gapPct: number
}) => ({
  positions: f.positions,
  realRepaidUsd: f.realRepaidUsd,
  memRepaidUsd: f.memRepaidUsd,
  gapPct: f.gapPct,
})
const setBrief = (s: typeof all) => ({
  positions: s.positions,
  realRepaidUsd: s.realRepaidUsd,
  memRepaidUsd: s.memRepaidUsd,
  gapUsd: s.gapUsd,
  gapPct: s.gapPct,
  less: s.less,
  more: s.more,
  lessUsd: s.lessUsd,
  moreUsd: s.moreUsd,
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
  excluded: {
    noMembraneLine: {
      positions: M.exclusions.noMembraneLine.positions,
      realRepaidUsd: M.exclusions.noMembraneLine.realRepaidUsd,
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
  all: setBrief(all),
  aave: setBrief(aave),
  morpho: setBrief(morpho),
  less: all.less,
  more: all.more,
  equal: all.equal,
  lessUsd: all.lessUsd,
  moreUsd: all.moreUsd,
  unpricedPositions: unpriced.positions,
  gridEnd: { positions: meta.gridEnd.positions, memRepaidUsd: meta.gridEnd.memRepaidUsd },
  neverSold: time.neverSold,
  collateralAtRiskUsd: landing.collateralAtRiskUsd,
  medians: {
    all: all.medians.all,
    atLeastFloor: all.medians.atLeastFloor,
  },
  concentration: {
    top1GapUsd: all.concentration.top5[0].gapUsd,
    top1Protocol: all.concentration.top5[0].protocol,
    top1Chain: all.concentration.top5[0].chain,
    top1Owner: all.concentration.top5[0].owner,
    top1Outcome: all.concentration.top5[0].outcome,
    gapWithoutTop1Pct: all.concentration.gapWithoutTop1Pct,
    top5Share: all.concentration.top5Share,
    gapWithoutTop5Pct: all.concentration.gapWithoutTop5Pct,
  },
  brackets,
  membraneMore,
  sensitivity: {
    band: bandSensitivity.map((b) => ({ band: b.band, memRepaidUsd: b.memRepaidUsd })),
    noEarlyClearUsd: noEarlyClear.memRepaidUsd,
    noDebtFloorUsd: noDebtFloor.memRepaidUsd,
    singleSaleUsd: singleSale.memRepaidUsd,
    noWalkOnUsd: time.sensitivity.noWalkOnAfterT0BandSale.memRepaidUsd,
    t0AtNm1Usd: time.sensitivity.t0PriceBasis.memRepaidUsd,
    /** The whole published table, each row on its own compared set, with the split. */
    table: sensitivityTable.map((r) => ({
      key: r.key,
      label: r.label,
      headline: r.headline,
      positions: r.positions,
      realRepaidUsd: r.realRepaidUsd,
      memRepaidUsd: r.memRepaidUsd,
      gapPct: r.gapPct,
      aaveGapPct: r.byProtocol['aave-v3'].gapPct,
      morphoGapPct: r.byProtocol['morpho-blue'].gapPct,
    })),
    /** Each on its own compared set: positions and both sides. */
    capacity: capacityRuns.map((c) => ({
      multiplier: c.multiplier === Infinity ? null : c.multiplier,
      positions: c.set.positions,
      realRepaidUsd: c.set.realRepaidUsd,
      memRepaidUsd: c.set.memRepaidUsd,
      gapPct: c.set.gapPct,
    })),
    protocolLine: {
      positions: protocolLine.set.positions,
      realRepaidUsd: protocolLine.set.realRepaidUsd,
      memRepaidUsd: protocolLine.set.memRepaidUsd,
      gapPct: protocolLine.set.gapPct,
      aave: setPick(protocolLine.set.byProtocol['aave-v3']),
      morpho: setPick(protocolLine.set.byProtocol['morpho-blue']),
    },
  },
}

// ---- print & write ---------------------------------------------------------------------------------
const json = JSON.stringify(doc) + '\n'
const headJson = JSON.stringify(headlineDoc, null, 1) + '\n'
const m = (x: number) => `$${(x / 1e6).toFixed(2)}M`
console.log(
  `census ${meta.source.sha256.slice(0, 12)} · ${rows.length} positions · code ${codeCommit.slice(0, 10)}${codeDirty ? ' (dirty)' : ''}`,
)
for (const s of [all, aave, morpho]) {
  console.log(
    `  ${s.key.padEnd(12)} ${String(s.positions).padStart(5)}  real ${m(s.realRepaidUsd)}  mem ${m(s.memRepaidUsd)}  ${s.gapPct}% less  less/more/equal ${s.less}/${s.more}/${s.equal}  medians ${s.medians.all.realMedianFrac}/${s.medians.all.memMedianFrac}`,
  )
}
console.log('  outcomes', JSON.stringify(outcomes))
console.log('  cure', JSON.stringify({ ...cureSummary(pos), noDelay: time.cure.noDelay }))
console.log('  one repay', JSON.stringify(oneRepay))
console.log('  bands', JSON.stringify(bandSensitivity.map((b) => [b.band, b.memRepaidUsd])))
for (const r of sensitivityTable) {
  console.log(
    `  sens ${r.key.padEnd(26)} ${String(r.positions).padStart(5)}  real ${m(r.realRepaidUsd)}  mem ${m(r.memRepaidUsd)}  ${r.gapPct}%  less ${m(r.lessUsd)} more ${m(r.moreUsd)} | aave ${r.byProtocol['aave-v3'].positions} ${m(r.byProtocol['aave-v3'].realRepaidUsd)}→${m(r.byProtocol['aave-v3'].memRepaidUsd)} (${r.byProtocol['aave-v3'].gapPct}%) | morpho ${r.byProtocol['morpho-blue'].positions} ${m(r.byProtocol['morpho-blue'].realRepaidUsd)}→${m(r.byProtocol['morpho-blue'].memRepaidUsd)} (${r.byProtocol['morpho-blue'].gapPct}%)`,
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
