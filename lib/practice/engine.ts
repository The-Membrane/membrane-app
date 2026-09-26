/**
 * Practice engine — replay the Oct-10 crossing one minute at a time, pausing where
 * the delay timer classifies something, and let the reader act.
 *
 * Nothing here is a second copy of the rules. The minute classifier is `DelayTimer`
 * and the sale is the exact `sell` body of `cureWalk` (lib/position-sim/curePath.ts):
 * `membraneRepayValue` sized against the borrow cap, no fee, the reduced position
 * carried forward on the SAME ratio basis cureWalk uses. The test suite asserts that
 * an always-hold run reproduces `cureWalk()` bit-for-bit on every preset.
 *
 * FRAME. cureWalk demands `ratios[0] == 1` at the breach (its t0 IS the crossing). The
 * tape here starts earlier, at the window's first minute, so the reader sees the
 * approach. At the first ARM the engine rebases onto cureWalk's frame: collateral
 * becomes its value at that minute and the ratio series becomes
 * `ratios[k + j] / ratios[k]`. `cureWalkInputFor()` builds exactly that input, so the
 * two walks do the same floating-point arithmetic from the crossing on. Before the
 * crossing nothing can happen (the timer returns `none`), so no arithmetic is lost.
 *
 * ONE KNOWN NON-EQUIVALENCE, stated: if the very first crossing lands past the band
 * (an `Immediate` sale with no delay), cureWalk returns `sold-at-t0` after one repay
 * and stops, while this engine keeps walking. `cureWalkInputFor` reports that case as
 * `firstCrossingPastBand: true`; no preset is built that way (tests assert it).
 *
 * The state object is MUTABLE: `step` and `apply` change it in place and return it.
 * JSX-free and dependency-light so it runs under vitest in node.
 */

import { DelayTimer, cureWalk, type CureWalkInput, type CureWalkResult } from '@/lib/position-sim/curePath'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
  membraneMaxLtv,
  membraneRepayValue,
} from '@/lib/position-sim/membrane'
import { buildPricePath, loadOct10, priceAt, type Oct10Manifest, type Oct10Series } from '@/lib/position-sim/scenario'
import { runComparison, measuredRepayFraction } from '@/lib/position-sim/compare'
import { DEFAULT_LIQ_FEE } from '@/lib/position-sim/history'
import type { PricePath, ProtocolPosition } from '@/lib/position-sim/types'

// ------------------------------------------------------------------ data

export interface Oct10Data {
  series: Oct10Series
  manifest: Oct10Manifest
}

/** Injectable so tests can read public/data/oct10-2025 from disk. */
export type Oct10Loader = () => Promise<Oct10Data>

export function loadPracticeData(loader: Oct10Loader = loadOct10): Promise<Oct10Data> {
  return loader()
}

// ---------------------------------------------------------------- assets

export type PracticeAsset = 'ETH' | 'BTC' | 'wstETH'

export const PRACTICE_ASSETS: PracticeAsset[] = ['ETH', 'BTC', 'wstETH']

/** The price-path symbol each asset is read through (scenario.ts SYMBOL_TO_SERIES). */
export const PRACTICE_SYMBOL: Record<PracticeAsset, string> = {
  ETH: 'ETH',
  BTC: 'WBTC',
  wstETH: 'wstETH',
}

/** The modelled Membrane line for the asset (membrane.ts MEMBRANE_ASSET_LTV). */
export function defaultLine(asset: PracticeAsset): number {
  const v = membraneMaxLtv(PRACTICE_SYMBOL[asset])
  if (v === null) throw new Error(`No Membrane line for ${asset}`)
  return v
}

/** Collateral value at t0. A size, not a claim: every output scales with it. */
export const DEFAULT_COLLATERAL_USD = 100_000

/** Same cap as cureWalk's default. */
const MAX_SALES = 20

/** Band-approach pause: within this many LTV points of line × (1 + band). */
export const BAND_APPROACH_PP = 0.01

// -------------------------------------------------------------- scenario

export interface Scenario {
  asset: PracticeAsset
  symbol: string
  line: number
  band: number
  gap: number
  /** Borrow line = line − gap; the repay restores to it. */
  cap: number
  /** line × (1 + band). Strictly above it the window breaks. */
  breakLine: number
  delaySteps: number
  stepSeconds: number
  startTs: number
  count: number
  openLtv: number
  collateralUsd0: number
  debtUsd0: number
  debtMinimumUsd: number
  maxSales: number
  /** Oracle price per minute, forward-filled for display only. */
  prices: number[]
  /** Raw price / price[0]; nulls kept (cureWalk carries the last ratio across them). */
  ratios: (number | null)[]
  path: PricePath
}

export interface ScenarioInput {
  asset: PracticeAsset
  openLtv: number
  /** Defaults to the modelled Membrane line for the asset. */
  line?: number
  collateralUsd?: number
  /** Defaults to the deployed $2,000 `liqDebtMinimum`. */
  debtMinimumUsd?: number
}

export function makeScenario(data: Oct10Data, input: ScenarioInput): Scenario {
  const symbol = PRACTICE_SYMBOL[input.asset]
  const { path, unpriced } = buildPricePath(data.series, data.manifest, [symbol])
  if (unpriced.length > 0) throw new Error(`Oct 10 data has no series for ${symbol}`)
  const raw = path.series[symbol]
  const p0 = priceAt(path, symbol, 0)
  if (p0 === null || !(p0 > 0)) throw new Error(`Oct 10 data has no first price for ${symbol}`)
  const prices: number[] = []
  const ratios: (number | null)[] = []
  for (let i = 0; i < path.count; i++) {
    prices.push(priceAt(path, symbol, i) ?? p0)
    const v = raw[i]
    ratios.push(v === null ? null : v / p0)
  }
  const line = input.line ?? defaultLine(input.asset)
  const band = MAX_THRESHOLD_TO_DELAY
  const gap = BORROW_LTV_GAP
  const collateralUsd0 = input.collateralUsd ?? DEFAULT_COLLATERAL_USD
  return {
    asset: input.asset,
    symbol,
    line,
    band,
    gap,
    cap: Math.max(0, line - gap),
    breakLine: line * (1 + band),
    // Identical to cureWalk: ceil(delaySeconds / stepSeconds).
    delaySteps: Math.max(1, Math.ceil(CURE_WINDOW_SECONDS / path.stepSeconds)),
    stepSeconds: path.stepSeconds,
    startTs: path.startTs,
    count: path.count,
    openLtv: input.openLtv,
    collateralUsd0,
    debtUsd0: input.openLtv * collateralUsd0,
    debtMinimumUsd: input.debtMinimumUsd ?? LIQ_DEBT_MINIMUM_USD,
    maxSales: MAX_SALES,
    prices,
    ratios,
    path,
  }
}

// ---------------------------------------------------------------- presets

export type PresetKind = 'inside' | 'through'

export interface Preset {
  asset: PracticeAsset
  kind: PresetKind
  line: number
  openLtv: number
  /** The LTV the opening position reaches at the tape's worst minute. */
  worstLtv: number
  worstIndex: number
}

/**
 * Presets are DERIVED from the tape, never guessed. `minRatio` is the lowest
 * price[i]/price[0] in the window; a position opened at `openLtv` reaches
 * `openLtv / minRatio` there. So:
 *   inside  — the worst minute sits 2 pp over the line (inside the 4% band)
 *   through — the worst minute sits 2 pp over line × (1 + band) (breaks the band)
 */
export function presetFor(data: Oct10Data, asset: PracticeAsset, kind: PresetKind): Preset {
  const sc = makeScenario(data, { asset, openLtv: 0.5 })
  let minRatio = Infinity
  let worstIndex = 0
  let last = 1
  for (let i = 0; i < sc.count; i++) {
    const r = sc.ratios[i] ?? last
    last = r
    if (r < minRatio) {
      minRatio = r
      worstIndex = i
    }
  }
  const worstLtv = kind === 'inside' ? sc.line + 0.02 : sc.breakLine + 0.02
  return { asset, kind, line: sc.line, openLtv: worstLtv * minRatio, worstLtv, worstIndex }
}

export function allPresets(data: Oct10Data): Preset[] {
  const out: Preset[] = []
  for (const a of PRACTICE_ASSETS) for (const k of ['inside', 'through'] as PresetKind[]) out.push(presetFor(data, a, k))
  return out
}

// ------------------------------------------------------------------ state

export type PauseKind = 'arm' | 'mid-window' | 'band-approach'

export type Choice = 'add-10' | 'add-25' | 'repay-to-borrow-line' | 'repay-half-way' | 'hold'

export const CHOICES: Choice[] = ['add-10', 'add-25', 'repay-to-borrow-line', 'repay-half-way', 'hold']

export interface SaleRecord {
  index: number
  reason: 'band' | 'expiry'
  /** Debt repaid by the sale. */
  repaidUsd: number
  /** Collateral value taken (== repaid: the census charges no fee). */
  seizedUsd: number
  ltvBefore: number
}

export interface ChoiceRecord {
  index: number
  pause: PauseKind | null
  choice: Choice
  /** Collateral added or debt repaid by the reader, USD. 0 for hold / no-op. */
  usd: number
  ltvBefore: number
  ltvAfter: number
}

export interface PracticeState {
  sc: Scenario
  /** Index of the last minute processed. 0 = the opening minute. */
  index: number
  debt: number
  /** Collateral on the current frame's basis: value at minute i = collBase × ratio. */
  collBase: number
  /** Collateral with no sales, same basis (for kept %). */
  postedBase: number
  /** The current minute's frame ratio. */
  lastRatio: number
  /** Ratio series in the current frame. Before the first arm it is `sc.ratios`. */
  frame: (number | null)[]
  frameStart: number
  rebasedAt: number | null
  timer: DelayTimer
  /** Minute the running timer armed, or null. */
  armedAt: number | null
  firedThisEpisode: PauseKind[]
  /** Last observed LTV per minute (index-aligned; entries after `index` are absent). */
  ltvTrace: number[]
  sales: SaleRecord[]
  choices: ChoiceRecord[]
  closedUsd: number
  addedUsd: number
  repaidUsd: number
  /** No further sale can run (mirror of cureWalk's loop break). */
  halted: boolean
  /** The tape has ended (grid-end resolution included). */
  finished: boolean
}

export function initialState(sc: Scenario): PracticeState {
  const timer = new DelayTimer({ line: sc.line, band: sc.band, delaySteps: sc.delaySteps })
  const r0 = sc.ratios[0] ?? 1
  const collAt = sc.collateralUsd0 * r0
  const ltv0 = collAt > 0 ? sc.debtUsd0 / collAt : Infinity
  const st: PracticeState = {
    sc,
    index: 0,
    debt: sc.debtUsd0,
    collBase: sc.collateralUsd0,
    postedBase: sc.collateralUsd0,
    lastRatio: r0,
    frame: sc.ratios,
    frameStart: 0,
    rebasedAt: null,
    timer,
    armedAt: null,
    firedThisEpisode: [],
    ltvTrace: [ltv0],
    sales: [],
    choices: [],
    closedUsd: 0,
    addedUsd: 0,
    repaidUsd: 0,
    halted: false,
    finished: false,
  }
  return st
}

export function collateralUsd(st: PracticeState): number {
  return st.collBase * st.lastRatio
}

export function currentLtv(st: PracticeState): number {
  const c = collateralUsd(st)
  return c > 0 ? st.debt / c : st.debt > 0 ? Infinity : 0
}

/** The exact `sell` body of cureWalk (curePath.ts:368-385), minus the unused cap. */
function sell(st: PracticeState, i: number, r: number, reason: 'band' | 'expiry'): boolean {
  const { sc } = st
  const collAt = st.collBase * r
  let repaid = membraneRepayValue(st.debt, collAt, sc.cap, sc.debtMinimumUsd)
  if (repaid > st.debt) repaid = st.debt
  if (!(repaid > 0)) return st.debt > 0 && collAt > 0 && st.sales.length < sc.maxSales
  const seized = Math.min(repaid, collAt)
  const ltvBefore = collAt > 0 ? st.debt / collAt : Infinity
  st.closedUsd += repaid
  st.debt -= repaid
  st.collBase = r > 0 ? (collAt - seized) / r : 0
  st.sales.push({ index: i, reason, repaidUsd: repaid, seizedUsd: seized, ltvBefore })
  st.timer.clearAfterSale()
  return st.debt > 1e-6 && st.collBase > 1e-6 && st.sales.length < sc.maxSales
}

export interface StepResult {
  state: PracticeState
  pause?: PauseKind
  sale?: SaleRecord
}

/** Advance one minute. Mutates and returns the state. */
export function step(st: PracticeState): StepResult {
  const { sc } = st
  if (st.finished) return { state: st }
  const n = sc.count
  let pause: PauseKind | undefined
  let sale: SaleRecord | undefined

  if (!st.halted && st.index < n - 1) {
    const i = st.index + 1
    st.index = i
    const raw = st.frame[i - st.frameStart]
    const r = raw == null || !(raw > 0) ? st.lastRatio : raw
    st.lastRatio = r
    const collAt = st.collBase * r
    const ltv = collAt > 0 ? st.debt / collAt : st.debt > 0 ? Infinity : 0
    const act = st.timer.step(i, ltv)

    if (act.kind === 'arm') {
      if (st.rebasedAt === null) {
        // Move onto cureWalk's frame: t0 = this crossing, ratio 1.
        const base = r
        const rebased: (number | null)[] = []
        for (let k = i; k < n; k++) {
          const v = sc.ratios[k]
          rebased.push(v === null ? null : v / base)
        }
        rebased[0] = 1
        st.postedBase = st.postedBase * base
        st.collBase = collAt
        st.frame = rebased
        st.frameStart = i
        st.lastRatio = 1
        st.rebasedAt = i
      }
      st.armedAt = i
      st.firedThisEpisode = ['arm']
      pause = 'arm'
    } else if (act.kind === 'save') {
      st.armedAt = null
      st.firedThisEpisode = []
    } else if (act.kind === 'sell') {
      st.armedAt = null
      st.firedThisEpisode = []
      const ok = sell(st, i, st.lastRatio, act.reason)
      const last = st.sales[st.sales.length - 1]
      if (last && last.index === i) sale = last
      if (!ok) st.halted = true
    } else if (act.kind === 'hold' && st.armedAt !== null) {
      if (ltv > sc.breakLine - BAND_APPROACH_PP && !st.firedThisEpisode.includes('band-approach')) {
        pause = 'band-approach'
      } else if (i - st.armedAt >= Math.floor(sc.delaySteps / 2) && !st.firedThisEpisode.includes('mid-window')) {
        pause = 'mid-window'
      }
      if (pause) st.firedThisEpisode.push(pause)
    }
    st.ltvTrace[i] = currentLtv(st)
  }

  if (st.halted || st.index >= n - 1) {
    // cureWalk:404-408 — an unresolved delay at grid end sells at the last price.
    if (st.timer.armed) {
      const before = st.sales.length
      sell(st, n - 1, st.lastRatio, 'expiry')
      if (st.sales.length > before) sale = st.sales[st.sales.length - 1]
      st.armedAt = null
    }
    st.finished = true
    pause = undefined
  }
  return { state: st, pause, sale }
}

/** Apply a reader's choice at the current minute. The next `step` re-classifies. */
export function apply(st: PracticeState, choice: Choice, pause: PauseKind | null = null): PracticeState {
  const collAt = collateralUsd(st)
  const ltvBefore = currentLtv(st)
  let usd = 0
  if (choice === 'add-10' || choice === 'add-25') {
    const frac = choice === 'add-10' ? 0.1 : 0.25
    usd = frac * collAt
    if (usd > 0 && st.lastRatio > 0) {
      st.collBase += usd / st.lastRatio
      st.postedBase += usd / st.lastRatio
      st.addedUsd += usd
    } else usd = 0
  } else if (choice === 'repay-to-borrow-line' || choice === 'repay-half-way') {
    const full = st.debt - st.sc.cap * collAt
    if (full > 0) {
      usd = choice === 'repay-to-borrow-line' ? full : full / 2
      st.debt -= usd
      st.repaidUsd += usd
    }
  }
  const ltvAfter = currentLtv(st)
  st.ltvTrace[st.index] = ltvAfter
  st.choices.push({ index: st.index, pause, choice, usd, ltvBefore, ltvAfter })
  return st
}

/** What a choice would do right now, without doing it. */
export function previewChoice(st: PracticeState, choice: Choice): { usd: number; ltvAfter: number } {
  const collAt = collateralUsd(st)
  if (choice === 'add-10' || choice === 'add-25') {
    const usd = (choice === 'add-10' ? 0.1 : 0.25) * collAt
    return { usd, ltvAfter: collAt + usd > 0 ? st.debt / (collAt + usd) : 0 }
  }
  if (choice === 'repay-to-borrow-line' || choice === 'repay-half-way') {
    const full = Math.max(0, st.debt - st.sc.cap * collAt)
    const usd = choice === 'repay-to-borrow-line' ? full : full / 2
    return { usd, ltvAfter: collAt > 0 ? (st.debt - usd) / collAt : 0 }
  }
  return { usd: 0, ltvAfter: currentLtv(st) }
}

export type Policy = (pause: PauseKind, st: PracticeState) => Choice

export function runToEnd(st: PracticeState, policy?: Policy): PracticeState {
  while (!st.finished) {
    const { pause } = step(st)
    if (pause && policy) apply(st, policy(pause, st), pause)
  }
  return st
}

/** Step until the next pause or the end. */
export function runToPause(st: PracticeState): StepResult {
  let res: StepResult = { state: st }
  while (!st.finished) {
    res = step(st)
    if (res.pause) return res
  }
  return res
}

export interface Score {
  collateralKeptUsd: number
  /** Share of every unit of collateral posted (opening + added) still held. */
  collateralKeptPct: number
  sales: number
  soldUsd: number
  addedUsd: number
  repaidUsd: number
  debtUsd: number
}

export function score(st: PracticeState): Score {
  const kept = st.collBase * st.lastRatio
  return {
    collateralKeptUsd: kept,
    collateralKeptPct: st.postedBase > 0 ? st.collBase / st.postedBase : 0,
    sales: st.sales.length,
    soldUsd: st.sales.reduce((a, s) => a + s.seizedUsd, 0),
    addedUsd: st.addedUsd,
    repaidUsd: st.repaidUsd,
    debtUsd: st.debt,
  }
}

// -------------------------------------------------------- cureWalk baseline

export interface CureWalkFrame {
  input: CureWalkInput
  crossingIndex: number
  firstCrossingPastBand: boolean
}

/**
 * The cureWalk input for this scenario: t0 moved to the first minute the opening
 * position crosses its line, collateral valued there, ratios rebased to 1 there.
 * Null when the position never crosses.
 */
export function cureWalkInputFor(sc: Scenario): CureWalkFrame | null {
  let last = sc.ratios[0] ?? 1
  for (let i = 1; i < sc.count; i++) {
    const raw = sc.ratios[i]
    const r = raw == null || !(raw > 0) ? last : raw
    last = r
    const collAt = sc.collateralUsd0 * r
    const ltv = collAt > 0 ? sc.debtUsd0 / collAt : Infinity
    if (ltv > sc.line) {
      const rebased: (number | null)[] = []
      for (let k = i; k < sc.count; k++) {
        const v = sc.ratios[k]
        rebased.push(v === null ? null : v / r)
      }
      rebased[0] = 1
      return {
        crossingIndex: i,
        firstCrossingPastBand: ltv > sc.breakLine,
        input: {
          debtUsd: sc.debtUsd0,
          collateralUsd: collAt,
          line: sc.line,
          band: sc.band,
          delaySeconds: CURE_WINDOW_SECONDS,
          stepSeconds: sc.stepSeconds,
          gap: sc.gap,
          ratios: rebased,
          debtMinimumUsd: sc.debtMinimumUsd,
          maxSales: sc.maxSales,
        },
      }
    }
  }
  return null
}

export interface Baseline {
  frame: CureWalkFrame | null
  /** cureWalk's own result, or null when the position never crosses. */
  cure: CureWalkResult | null
  /** The engine's always-hold run (equal to cureWalk; the tests hold it to that). */
  score: Score
  state: PracticeState
}

export function membraneNoAction(sc: Scenario): Baseline {
  const frame = cureWalkInputFor(sc)
  const cure = frame ? cureWalk(frame.input) : null
  const state = runToEnd(initialState(sc))
  return { frame, cure, score: score(state), state }
}

// ------------------------------------------------ what the liquidators took

export interface MeasuredLiquidations {
  aaveV3?: { medianRepayFraction?: number; events?: number }
  morphoBlue?: { medianRepayFraction?: number; events?: number }
}

export interface LiquidatorResult {
  collateralKeptUsd: number
  collateralKeptPct: number
  liquidations: number
  seizedUsd: number
  repayFraction: number
  repayFractionLabel: string
  bonus: number
}

/**
 * The Aave-style engine from lib/position-sim/compare.ts (`runComparison().source`):
 * at the same line, every minute over it the liquidator repays the MEASURED Oct-10
 * Aave median share of the loan and seizes that plus `DEFAULT_LIQ_FEE`. No window.
 */
export function liquidatorBaseline(sc: Scenario, measured: MeasuredLiquidations | null): LiquidatorResult {
  const { fraction, label } = measuredRepayFraction('aave-v3', measured)
  const { path } = buildPricePathForLiquidator(sc)
  const p0 = sc.prices[0]
  const position: ProtocolPosition = {
    protocol: 'aave-v3',
    label: 'Aave-style',
    collateral: [
      {
        symbol: sc.symbol,
        address: '',
        decimals: 18,
        amount: sc.collateralUsd0 / p0,
        priceUsd: p0,
        valueUsd: sc.collateralUsd0,
        liquidationThreshold: sc.line,
        maxLtv: sc.cap,
        liquidationBonus: DEFAULT_LIQ_FEE,
      },
    ],
    debt: [
      { symbol: 'USDC', address: '', decimals: 6, amount: sc.debtUsd0, priceUsd: 1, valueUsd: sc.debtUsd0, borrowApr: null },
    ],
    totalCollateralUsd: sc.collateralUsd0,
    totalDebtUsd: sc.debtUsd0,
    ltv: sc.openLtv,
    liquidationLtv: sc.line,
    healthFactor: sc.line / sc.openLtv,
    provenance: sc.path.provenance,
  }
  const cmp = runComparison(position, path, [], {
    membraneMaxLtv: sc.line,
    membraneLiqFee: 0,
    venue: null,
    sourceRepayFraction: fraction,
    sourceRepayFractionLabel: label,
    scenarioLabel: 'Oct 10 2025',
    debtMinimumUsd: sc.debtMinimumUsd,
  })
  const src = cmp.source
  const endPrice = sc.prices[sc.count - 1]
  const untouched = (sc.collateralUsd0 / p0) * endPrice
  return {
    collateralKeptUsd: src.endCollateralUsd,
    collateralKeptPct: untouched > 0 ? src.endCollateralUsd / untouched : 0,
    liquidations: src.events.length,
    seizedUsd: src.events.reduce((a, e) => a + e.seizedUsd, 0),
    repayFraction: fraction,
    repayFractionLabel: label,
    bonus: DEFAULT_LIQ_FEE,
  }
}

function buildPricePathForLiquidator(sc: Scenario): { path: PricePath } {
  // Same measured column, plus the USDC debt leg held at $1 (scenario.ts HELD_AT_ONE).
  const flat = new Array<number | null>(sc.count).fill(1)
  return {
    path: { ...sc.path, series: { ...sc.path.series, USDC: flat } },
  }
}

// ------------------------------------------------------------- formatting

export const fmtPct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`
export const fmtUsd = (x: number) => '$' + Math.round(x).toLocaleString('en-US')

export function clockAt(sc: Scenario, index: number): string {
  const d = new Date((sc.startTs + index * sc.stepSeconds) * 1000)
  const day = d.getUTCDate() === 10 ? 'Oct 10' : `Oct ${d.getUTCDate()}`
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

export function elapsed(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}
