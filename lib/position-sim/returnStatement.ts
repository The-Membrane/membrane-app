/**
 * returnStatement — the RETURN half of the set-and-forget sim (board Q20; owner direction
 * 2026-10-11, "historical return statements"). ENGINE ONLY: numbers, never copy, no I/O.
 * The driver is scripts/position-sim/set-and-forget-sim.ts `--returns`; the survival half
 * is setAndForget.ts.
 *
 * THE QUESTION. A position opened at the close of a historical hour and left untouched for
 * a horizon: what did it earn and what did it cost? Per window, on Membrane and on the
 * incumbent (Aave v3) for the same position on the same price path:
 *   yield earned       the venue supply APR × the debt still deployed, hour by hour
 *   borrow cost        Aave: the measured variable borrow APR × the debt still owed.
 *                      Membrane: deployed debt carries no interest; the cost is a
 *                      curator-set share of the venue yield (carryCost.ts), not fixed
 *                      pre-launch, so it is UNAVAILABLE, never priced
 *   collateral sold    each engine's own sales (Aave: seized incl. the liquidation bonus)
 *   yield given up     Membrane: what the capital its recalls drew would have earned for
 *                      the rest of the window. Aave: 0 by construction (no recall; a
 *                      liquidation is paid from collateral, the deployed debt stays)
 *
 * NEVER INVENTED (owner rule): a rate comes only from a measured series. A window the
 * series does not cover — no sample at or before its start, or a gap longer than the
 * series' `maxGapSeconds` inside it — gets `usd: null` and the reason. The venue yield is
 * lib/netApy's history (PR #92: pinned-block reads, scripts/position-sim/
 * build-net-apy-history.ts); the Aave borrow rate is the hourly on-chain read in
 * public/data/venue-stress/history.json.
 *
 * ARITHMETIC. Simple interest on a piecewise-constant balance: each rate sample holds
 * from its time to the next sample (sample-and-hold, the sample cadence is published),
 * each balance holds from its change to the next. No compounding (it would move a 90-day
 * figure by well under 1% of itself) and no interest accrual on the debt (the engines
 * omit it too: SET-AND-FORGET-LTV.md "Not modelled").
 *
 * HISTORY, NOT ODDS (design rules §4, §5b). A statement names its window. A summary over
 * many windows names its period and n, and reports quantiles of what happened. Nothing
 * here computes a share of windows that "won", a probability or a forecast.
 */
import { runIncumbent } from './compare'
import {
  casePosition,
  runCase,
  windowReplay,
  type HourlyPath,
  type PathResolution,
  type SetAndForgetCase,
} from './setAndForget'
import type { StressModelled } from './stressGrid'
import { stamp, type PricePath, type ProtocolPosition, type SimRun } from './types'

export const YEAR_SECONDS = 365 * 86400

// ---------------------------------------------------------------- series

/** A measured rate series. Each point holds from `t` until the next point. */
export interface RateSeries {
  /** e.g. 'net-apy:aave-v3-usdc:supplyApr@50000000'. */
  id: string
  /** Where the numbers come from, in one line. */
  source: string
  /** Sorted by t (unix s). `apr` is a fraction per year. */
  t: Float64Array
  apr: Float64Array
  /** A gap between samples longer than this leaves the stretch uncovered. */
  maxGapSeconds: number
}

export function rateSeries(
  id: string,
  source: string,
  points: readonly { t: number; apr: number }[],
  maxGapSeconds: number,
): RateSeries {
  const ok = points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.apr))
    .sort((a, b) => a.t - b.t)
  return {
    id,
    source,
    t: Float64Array.from(ok, (p) => p.t),
    apr: Float64Array.from(ok, (p) => p.apr),
    maxGapSeconds,
  }
}

/** Index of the last sample at or before `ts`, or -1. */
function indexAt(s: RateSeries, ts: number): number {
  let lo = 0
  let hi = s.t.length - 1
  if (hi < 0 || s.t[0] > ts) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s.t[mid] <= ts) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Whether the series covers [fromTs, toTs]: a sample at or before `fromTs`, no gap longer
 * than `maxGapSeconds` from it through `toTs`. The reason names the first hole.
 */
export function covers(
  s: RateSeries,
  fromTs: number,
  toTs: number,
): { ok: true } | { ok: false; why: string } {
  const iso = (x: number) => new Date(x * 1000).toISOString().slice(0, 16) + 'Z'
  const i0 = indexAt(s, fromTs)
  if (i0 < 0) {
    return {
      ok: false,
      why: s.t.length
        ? `${s.id}: no sample before ${iso(fromTs)} (series starts ${iso(s.t[0])})`
        : `${s.id}: empty series`,
    }
  }
  let prev = s.t[i0]
  for (let i = i0 + 1; i < s.t.length && s.t[i] <= toTs; i++) {
    if (s.t[i] - prev > s.maxGapSeconds)
      return { ok: false, why: `${s.id}: no sample ${iso(prev)} → ${iso(s.t[i])}` }
    prev = s.t[i]
  }
  if (toTs - prev > s.maxGapSeconds)
    return { ok: false, why: `${s.id}: no sample after ${iso(prev)} (needed to ${iso(toTs)})` }
  return { ok: true }
}

/** A balance that holds `usd` from `t` until the next step. Sorted by t. */
export interface BalanceStep {
  t: number
  usd: number
}

/**
 * ∫ balance(t) × apr(t) dt / YEAR over [fromTs, toTs], USD. Before the first balance step
 * the balance is 0. Null when the series does not cover the window (`covers`).
 */
export function accrue(
  s: RateSeries,
  fromTs: number,
  toTs: number,
  balance: readonly BalanceStep[],
): number | null {
  if (!(toTs > fromTs)) return 0
  if (!covers(s, fromTs, toTs).ok) return null
  let i = indexAt(s, fromTs)
  let k = -1
  while (k + 1 < balance.length && balance[k + 1].t <= fromTs) k++
  let t = fromTs
  let sum = 0
  while (t < toTs) {
    const nextRate = i + 1 < s.t.length ? s.t[i + 1] : Infinity
    const nextBal = k + 1 < balance.length ? balance[k + 1].t : Infinity
    const end = Math.min(toTs, nextRate, nextBal)
    const bal = k >= 0 ? balance[k].usd : 0
    sum += bal * s.apr[i] * (end - t)
    t = end
    if (t === nextRate) i++
    if (t === nextBal) k++
  }
  return sum / YEAR_SECONDS
}

// ---------------------------------------------------------------- lines

/** One line of a statement. `usd: null` = unavailable; `why` says why. */
export type Line = { usd: number; basis: string } | { usd: null; why: string }

const line = (usd: number | null, basis: string, why: string): Line =>
  usd === null ? { usd: null, why } : { usd, basis }

/** Why Membrane's borrow cost has no number (carryCost.ts header, owner ruling). */
export const MEMBRANE_BORROW_COST_WHY =
  'curator-set share of the venue yield; not fixed pre-launch, so not priced (deployed debt carries no interest)'
/** Why Membrane's undeployed (levered long) debt has no rate. */
export const MEMBRANE_UNDEPLOYED_RATE_WHY =
  'Membrane interest on undeployed debt is not fixed pre-launch, so not priced'

export interface MembraneReturn {
  /** Gross venue supply yield on the deployed debt, before Membrane's curator-set share:
   *  an UPPER BOUND on what reaches the user. */
  yieldEarned: Line
  borrowCost: Line
  /** Collateral sold, USD at sale-time prices, the engine's `exposedUsd` (fees omitted;
   *  a sale in the held tail after the horizon counts, as in the survival table). */
  collateralSold: Line
  yieldGivenUp: Line
  /** Deployed capital the recalls drew over the whole run. */
  recallDrawnUsd: number
}

/**
 * Membrane's statement from one TRACED stressGrid run (`runStress(..., { trace: true })`).
 * `deployedUsd` is the debt deployed at t0 (carry: all of it; levered long: 0).
 */
export function membraneReturn(input: {
  startTs: number
  horizonSeconds: number
  deployedUsd: number
  run: StressModelled
  /** The venue supply APR at Membrane's book size. Null = no series for this venue. */
  supply: RateSeries | null
}): MembraneReturn {
  const { startTs, horizonSeconds, deployedUsd, run } = input
  if (!run.trace) throw new Error('membraneReturn: run the engine with { trace: true }')
  const endTs = startTs + horizonSeconds
  const deployed: BalanceStep[] = [{ t: startTs, usd: deployedUsd }]
  const drawnSoFar: BalanceStep[] = [{ t: startTs, usd: 0 }]
  let left = deployedUsd
  let drawn = 0
  for (const e of run.trace) {
    if (!(e.recallUsd > 0)) continue
    left -= e.recallUsd
    drawn += e.recallUsd
    deployed.push({ t: startTs + e.seconds, usd: Math.max(0, left) })
    drawnSoFar.push({ t: startTs + e.seconds, usd: drawn })
  }
  const sold: Line = { usd: run.exposedUsd, basis: 'stressGrid runStress replay (fees omitted)' }
  const borrowCost: Line = {
    usd: null,
    why: deployedUsd > 0 ? MEMBRANE_BORROW_COST_WHY : MEMBRANE_UNDEPLOYED_RATE_WHY,
  }
  if (!(deployedUsd > 0)) {
    const none: Line = { usd: 0, basis: 'nothing deployed (levered long)' }
    return {
      yieldEarned: none,
      borrowCost,
      collateralSold: sold,
      yieldGivenUp: none,
      recallDrawnUsd: 0,
    }
  }
  const s = input.supply
  if (!s) {
    const why = 'no net-APY history for this venue'
    return {
      yieldEarned: { usd: null, why },
      borrowCost,
      collateralSold: sold,
      yieldGivenUp: { usd: null, why },
      recallDrawnUsd: drawn,
    }
  }
  const cov = covers(s, startTs, endTs)
  const why = cov.ok ? '' : cov.why
  return {
    yieldEarned: line(accrue(s, startTs, endTs, deployed), s.source, why),
    borrowCost,
    collateralSold: sold,
    yieldGivenUp: line(accrue(s, startTs, endTs, drawnSoFar), s.source, why),
    recallDrawnUsd: drawn,
  }
}

export interface IncumbentReturn {
  yieldEarned: Line
  borrowCost: Line
  /** Collateral seized, USD incl. the liquidation bonus (compare.ts SimEvent.seizedUsd). */
  collateralSold: Line
  /** The bonus part of `collateralSold`. */
  liquidationPenalty: Line
  /** 0 by construction: no recall exists, the deployed debt stays deployed. */
  yieldGivenUp: Line
}

/**
 * The incumbent's statement from one compare.ts `runIncumbent` run on the same path. The
 * debt is the start debt less what each liquidation repaid; the deployed debt never moves.
 */
export function incumbentReturn(input: {
  startTs: number
  horizonSeconds: number
  startDebtUsd: number
  deployedUsd: number
  run: SimRun
  /** The venue supply APR at the position's own size. */
  supply: RateSeries | null
  /** The measured variable borrow APR. */
  borrow: RateSeries | null
}): IncumbentReturn {
  const { startTs, horizonSeconds, startDebtUsd, deployedUsd, run } = input
  const endTs = startTs + horizonSeconds
  const debt: BalanceStep[] = [{ t: startTs, usd: startDebtUsd }]
  let owed = startDebtUsd
  let seized = 0
  let penalty = 0
  for (const e of run.events) {
    if (e.kind !== 'liquidation') continue
    owed -= e.repaidUsd
    seized += e.seizedUsd
    penalty += e.penaltyUsd
    debt.push({ t: e.ts, usd: Math.max(0, owed) })
  }
  const basis = 'compare.ts runIncumbent replay'
  const yieldEarned: Line = !(deployedUsd > 0)
    ? { usd: 0, basis: 'nothing deployed (levered long)' }
    : !input.supply
      ? { usd: null, why: 'no net-APY history for this venue' }
      : line(
          accrue(input.supply, startTs, endTs, [{ t: startTs, usd: deployedUsd }]),
          input.supply.source,
          (covers(input.supply, startTs, endTs) as { why?: string }).why ?? '',
        )
  const borrowCost: Line = !input.borrow
    ? { usd: null, why: 'no borrow-rate series' }
    : line(
        accrue(input.borrow, startTs, endTs, debt),
        input.borrow.source,
        (covers(input.borrow, startTs, endTs) as { why?: string }).why ?? '',
      )
  return {
    yieldEarned,
    borrowCost,
    collateralSold: { usd: seized, basis },
    liquidationPenalty: { usd: penalty, basis },
    yieldGivenUp: { usd: 0, basis: 'no recall: a liquidation is paid from collateral' },
  }
}

/** yield − borrow cost, when both are priced; else null with the first missing reason. */
export function netCarry(r: { yieldEarned: Line; borrowCost: Line }): Line {
  if (r.yieldEarned.usd === null) return r.yieldEarned
  if (r.borrowCost.usd === null) return r.borrowCost
  return { usd: r.yieldEarned.usd - r.borrowCost.usd, basis: 'yield earned − borrow cost' }
}

// ---------------------------------------------------------------- one window

/** A position opened at the close of hour `start` (drawdowns.ts GRID CONVENTION) and held
 *  `hours`: when it opens and when the window ends, unix s. */
export function windowTimes(
  p: HourlyPath,
  start: number,
  hours: number,
): { openTs: number; closeTs: number } {
  const openTs = p.startTs + (start + 1) * 3600
  return { openTs, closeTs: openTs + hours * 3600 }
}

/**
 * Membrane's statement for one window: ONE traced stressGrid run on the same replay the
 * survival table uses (setAndForget.ts `windowReplay`, `runCase`). Null when the path has
 * no complete window at `start`.
 */
export function membraneWindow(
  c: SetAndForgetCase,
  ltv: number,
  p: HourlyPath,
  start: number,
  hours: number,
  resolution: PathResolution,
  supply: RateSeries | null,
): { ret: MembraneReturn; run: StressModelled } | null {
  const shape = windowReplay(p, start, hours, resolution)
  if (!shape) return null
  const run = runCase(c, shape, ltv, { trace: true })
  const { openTs } = windowTimes(p, start, hours)
  const deployedUsd = c.tradeShape === 'carry' ? casePosition(c, ltv).debtUsd : 0
  return {
    ret: membraneReturn({
      startTs: openTs,
      horizonSeconds: hours * 3600,
      deployedUsd,
      run,
      supply,
    }),
    run,
  }
}

/** The incumbent's liquidation parameters for the collateral, read at the window's start. */
export interface IncumbentParams {
  /** e.g. 'Aave v3 WETH'. */
  label: string
  /** Liquidation threshold, 0–1. */
  liquidationThreshold: number
  /** Liquidation bonus, 0–1 (0.05 = 5% on top of the repaid debt). */
  liquidationBonus: number
  /** Share of the debt one liquidation repays (compare.ts `sourceRepayFraction`). */
  repayFraction: number
  repayFractionLabel: string
}

/**
 * The same position on the incumbent, as a compare.ts ProtocolPosition priced in units of
 * the entry price (collateral = `collateralUsd` units at $1; the path is the replay's
 * ratios, so every value is in t0 dollars like the stress engine's). Parameters are held
 * at their value at the window's start.
 */
export function incumbentPosition(
  collateralUsd: number,
  debtUsd: number,
  params: IncumbentParams,
): ProtocolPosition {
  const lt = params.liquidationThreshold
  return {
    protocol: 'aave-v3',
    label: params.label,
    collateral: [
      {
        symbol: 'COLLATERAL',
        address: '',
        decimals: 18,
        amount: collateralUsd,
        priceUsd: 1,
        valueUsd: collateralUsd,
        liquidationThreshold: lt,
        maxLtv: lt,
        liquidationBonus: params.liquidationBonus,
      },
    ],
    debt: [
      {
        symbol: 'USD',
        address: '',
        decimals: 6,
        amount: debtUsd,
        priceUsd: 1,
        valueUsd: debtUsd,
        borrowApr: null,
      },
    ],
    totalCollateralUsd: collateralUsd,
    totalDebtUsd: debtUsd,
    ltv: debtUsd / collateralUsd,
    liquidationLtv: lt,
    healthFactor: debtUsd > 0 ? (lt * collateralUsd) / debtUsd : Infinity,
    provenance: stamp(
      'modelled',
      `${params.label} · modelled position`,
      'Set-and-forget return statement: the same collateral and debt as the Membrane run.',
    ),
  }
}

/**
 * The incumbent's run for one window on the same replay as Membrane's. A missing
 * observation is null and compare.ts carries the last price forward (scenario.ts
 * `priceAt`), as the stress engine forward-fills. Null when no complete window.
 */
export function incumbentWindow(
  collateralUsd: number,
  debtUsd: number,
  p: HourlyPath,
  start: number,
  hours: number,
  resolution: PathResolution,
  params: IncumbentParams,
): SimRun | null {
  const shape = windowReplay(p, start, hours, resolution)
  if (!shape || shape.kind !== 'replay') return null
  const { openTs } = windowTimes(p, start, hours)
  const path: PricePath = {
    startTs: openTs,
    stepSeconds: shape.stepSeconds,
    count: shape.ratios.length,
    series: { COLLATERAL: [...shape.ratios] },
    provenance: stamp('dataset', shape.id),
  }
  return runIncumbent(incumbentPosition(collateralUsd, debtUsd, params), path, {
    venue: null,
    sourceRepayFraction: params.repayFraction,
    sourceRepayFractionLabel: params.repayFractionLabel,
  })
}

// ---------------------------------------------------------------- summary

/** Quantiles of what happened over n windows (lower nearest rank). History, not odds. */
export interface Dist {
  n: number
  min: number
  p10: number
  median: number
  p90: number
  max: number
}

export function distOf(values: readonly number[]): Dist | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const q = (f: number) => v[Math.floor(f * (v.length - 1))]
  return { n: v.length, min: v[0], p10: q(0.1), median: q(0.5), p90: q(0.9), max: v[v.length - 1] }
}

// ---------------------------------------------------------------- history file

export const NET_APY_HISTORY_SCHEMA = 'net-apy-history/v1'

/** The dataset directory in the private datasets repo (board rule N18). */
export const NET_APY_HISTORY_DIR = 'net-apy-history'

/** e.g. 'aave-v3-usdc-1h.json'. */
export const netApyHistoryFileName = (venueKeys: readonly string[], strideHours: number): string =>
  `${venueKeys.join('+')}-${strideHours}h.json`

export interface NetApyHistoryVenue {
  venueKey: string
  label: string
  columns: string[]
  /** The first sample block lib/netApy could read, and the last one it could not. */
  firstReadable: { t: number; b: number }
  lastUnreadable: { t: number; b: number; why: string } | null
  /** One row per sample, in `columns` order. */
  rows: (number | null)[][]
  /** Samples whose read failed after 3 tries: holes in the series, never filled. */
  failures: { t: number; b: number; why: string }[]
}

export interface NetApyHistoryFile {
  schema: typeof NET_APY_HISTORY_SCHEMA
  generatedAt: string
  source: string
  hosts: string[]
  strideSeconds: number
  sizesUsd: number[]
  semantics: Record<string, string>
  venues: Record<string, NetApyHistoryVenue>
}

/**
 * A column of the history as a rate series, on the sample block's own time. The allowed
 * gap is 1.5 strides (one missed sample is a hole; a late block is not).
 */
export function historySeries(
  file: NetApyHistoryFile,
  venueKey: string,
  column: string,
): RateSeries | null {
  const v = file.venues[venueKey]
  if (!v) return null
  const ci = v.columns.indexOf(column)
  const ti = v.columns.indexOf('blockTs')
  if (ci < 0 || ti < 0) throw new Error(`net-apy history ${venueKey}: no column ${column}`)
  const points: { t: number; apr: number }[] = []
  for (const r of v.rows) {
    const t = r[ti]
    const a = r[ci]
    if (t != null && a != null) points.push({ t, apr: a })
  }
  return rateSeries(
    `net-apy:${venueKey}:${column}`,
    `lib/netApy pinned reads (${file.strideSeconds / 3600}h samples)`,
    points,
    file.strideSeconds * 1.5,
  )
}
