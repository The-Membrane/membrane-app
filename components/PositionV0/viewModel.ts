/**
 * The /position page's view-model. Pure: adapter results in, everything the page prints out.
 * No React, no I/O, so tests/unit/positionV0ViewModel.test.ts covers every state.
 */

import { computeMetrics, type PositionMetrics } from '@/lib/positionAlerts/metrics'
import type { AdapterResult, AdapterStatus, ProtocolId, ProtocolPosition } from '@/lib/position-sim/types'
import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'

import {
  classifyRisk,
  heroOf,
  legSymbols,
  lineDistance,
  lineModel,
  type Hero,
  type LineModel,
  type RiskBasis,
} from '@/lib/position/liquidation'
import { referencePriceFrom } from '@/lib/position/alert'
import { fmtInt, fmtMove } from '@/lib/position/format'
import { reverseSolve, type ActionRow, type ReverseSolve } from '@/lib/position/reverseSolve'
import { HISTORY_LABEL, toSnapshot, type MappedSnapshot } from '@/lib/position/snapshot'
import {
  confidenceOf,
  lookupTouch,
  touchAtLevel,
  touchCurve,
  type ForecastConfidence,
  type TouchFrequency,
  type TouchLookup,
} from '@/lib/position/touch'
import {
  HORIZON_IDS,
  meanN,
  periodYears,
  shortSha,
  type Direction,
  type HistoryAsset,
  type HorizonId,
  type TouchTable,
} from '@/lib/position/touchHistory'

// ------------------------------------------------------------------ venues

/**
 * Each protocol's own public app root. Root URLs only: a deep link (market page, repay
 * modal) was not verified, so none is used. Fluid has no adapter, so no link.
 */
export const PROTOCOL_APP_URL: Record<ProtocolId, string | null> = {
  'aave-v3': 'https://app.aave.com/',
  spark: 'https://app.spark.fi/',
  'morpho-blue': 'https://app.morpho.org/',
  'compound-v3': 'https://app.compound.finance/',
  fluid: null,
}

/** The adapter's name for its read, shortened for the status line. */
export const PROTOCOL_SHORT: Record<ProtocolId, string> = {
  'aave-v3': 'Aave V3',
  spark: 'Spark',
  'morpho-blue': 'Morpho Blue',
  'compound-v3': 'Compound V3',
  fluid: 'Fluid',
}

/**
 * The true source of the price the hero quotes: what the adapter read. Aave and Spark
 * read AaveOracle.getAssetsPrices; Morpho derives a USD price from the market oracle's
 * loan-token quote; Compound reads Comet.getPrice on the asset's price feed. Which feed
 * sits behind each oracle (Chainlink, an exchange-rate adapter) is not read, so it is not
 * claimed.
 */
export function priceSourceOf(p: ProtocolPosition): string {
  switch (p.protocol) {
    case 'aave-v3':
      return 'Aave V3 oracle'
    case 'spark':
      return 'Spark oracle'
    case 'morpho-blue': {
      // The adapter's detail says how the loan token got its USD price: an assumed $1 peg,
      // or a read of the Aave V3 oracle. Both reach the hero's source line.
      const detail = p.provenance.detail ?? ''
      const assumed = detail.match(/loan token (\S+) treated as exactly \$1\.00/)
      if (assumed) return `Morpho market oracle, ${assumed[1]} taken as $1`
      const aave = detail.match(/Loan token (\S+) priced at \$[\d.e+-]+ from the Aave V3 oracle/)
      return aave ? `Morpho market oracle, ${aave[1]} priced by the Aave V3 oracle` : 'Morpho market oracle'
    }
    case 'compound-v3':
      return 'Compound V3 price feed'
    case 'fluid':
      return 'Fluid'
  }
}

// ------------------------------------------------------------------ read status

export type ReadState = 'pending' | AdapterStatus

export interface ReadStatusItem {
  protocol: ProtocolId
  label: string
  state: ReadState
  positions: number
  message?: string
}

/** Every adapter starts 'pending'; each result replaces its slot when it lands. */
export function readStatus(
  order: readonly { id: ProtocolId; label: string }[],
  results: Partial<Record<ProtocolId, AdapterResult>>,
): ReadStatusItem[] {
  return order.map((a) => {
    const r = results[a.id]
    if (!r) return { protocol: a.id, label: PROTOCOL_SHORT[a.id], state: 'pending', positions: 0 }
    return {
      protocol: a.id,
      label: PROTOCOL_SHORT[a.id],
      state: r.status,
      positions: r.positions.length,
      message: r.message,
    }
  })
}

/** "Aave V3 read" / "Fluid not supported yet" / "Spark failed" / "Morpho Blue reading…" */
export function statusWord(s: ReadStatusItem): string {
  switch (s.state) {
    case 'pending':
      return `${s.label} reading…`
    case 'ok':
      return `${s.label} read · ${s.positions} found`
    case 'empty':
      return `${s.label} read`
    case 'error':
      return `${s.label} failed`
    case 'unsupported':
      return `${s.label} not supported yet`
  }
}

/**
 * The one-line read status: "Aave V3 / Spark / Morpho Blue / Compound V3 read · Fluid not
 * supported yet". Groups keep registry order; a failure is named, never folded into "read".
 */
export function statusSentence(items: ReadStatusItem[]): string {
  const names = (pred: (i: ReadStatusItem) => boolean) => items.filter(pred).map((i) => i.label)
  const read = names((i) => i.state === 'ok' || i.state === 'empty')
  const pending = names((i) => i.state === 'pending')
  const failed = names((i) => i.state === 'error')
  const unsupported = names((i) => i.state === 'unsupported')
  const parts: string[] = []
  if (read.length) parts.push(`${read.join(' / ')} read`)
  if (pending.length) parts.push(`${pending.join(' / ')} reading…`)
  if (failed.length) parts.push(`${failed.join(' / ')} failed`)
  if (unsupported.length) parts.push(`${unsupported.join(' / ')} not supported yet`)
  return parts.join(' · ')
}

// ------------------------------------------------------------------ one position

/** The curve's shown range: −5% … −30% (FORECAST_VISUALS.md), widened to the reader's line. */
export const CURVE_RANGE = { from: 5, to: 30 } as const

/** One horizon of the forecast block: the reader's chance, the curve and its levers. */
export interface HorizonForecast {
  horizon: HorizonId
  /** The forecast at the reader's floored distance. Null outside the table (see `lookup`). */
  at: TouchFrequency | null
  /** The curve, one point per whole level over `range`. */
  curve: TouchFrequency[]
  range: { from: number; to: number }
  /** "Repay $X · line −Y% · Z% (lo–hi)" rows, solved at this horizon. */
  actions: ActionRow[]
  /** Why there are no rows ('ok' when there are), and the targets met / out of reach. */
  solve: Omit<ReverseSolve, 'rows'>
  confidence: ForecastConfidence
}

export interface ForecastView {
  asset: HistoryAsset
  direction: Direction
  /** "priced on ETH/USD history" */
  label: string
  /** The reader's line as a whole-percent table level (the hero distance, floored). */
  level: number
  lookup: TouchLookup['kind']
  byHorizon: Record<HorizonId, HorizonForecast>
  years: string
  /** "† forecast from ETH history 2021–26 (n ≈ 1,990 per horizon), not a guarantee" */
  footer: string
  /** "Chainlink ETH/USD hourly lows · membrane-datasets validation/t1 · 42c792d" */
  credit: string
  /** The same in one phone line: "Chainlink ETH/USD lows · validation/t1 · 42c792d" */
  creditShort: string
}

/** What the "Alert me at" row needs from the position. The price itself may need a read. */
export interface AlertInputs {
  asset: HistoryAsset
  direction: Direction
  /** The line's fraction from now. */
  distance: number
  /** The asset's price in this read (its WETH / WBTC leg), or null when it needs a read. */
  referencePrice: number | null
  /** Where referencePrice came from, for the stamp. */
  referenceSource: string
}

export interface PositionView {
  key: string
  protocol: ProtocolId
  label: string
  /** "Aave V3 · WETH / USDT": the adapter label, with the legs when it does not name them. */
  title: string
  appUrl: string | null
  priceSource: string
  position: ProtocolPosition
  mapped: MappedSnapshot
  metrics: PositionMetrics
  basis: RiskBasis
  model: LineModel | null
  hero: Hero
  /** Exact distance (fraction) for sorting; Infinity with no debt. */
  distance: number
  forecast: ForecastView | null
  /** Why there is no forecast, ≤ 8 words. Null when there is one, or no debt. */
  forecastAbsent: string | null
  alert: AlertInputs | null
  /** The modelling assumption behind the hero, or null when one price moves alone. */
  assumption: string | null
}

/**
 * The forecast's credit. Falls are validation/t1's own rows; t1 scores no rises, so a rise
 * credits the price history on the same origins instead of claiming t1.
 */
export function creditLine(t: TouchTable, asset: HistoryAsset, direction: Direction): string {
  return direction === 'fall'
    ? `${t.assets[asset].feed} hourly lows · membrane-datasets validation/t1 rows · ${shortSha(t)}`
    : `${t.assets[asset].feed} hourly highs · membrane-datasets price-history, t1's origins · ${shortSha(t)}`
}

/** The credit in one 390px line (≤ 54 characters of 11px mono). */
export function creditShort(t: TouchTable, asset: HistoryAsset, direction: Direction): string {
  return direction === 'fall'
    ? `${t.assets[asset].feed} lows · validation/t1 · ${shortSha(t)}`
    : `${t.assets[asset].feed} highs · t1 origins · ${shortSha(t)}`
}

/** FORECAST_VISUALS.md footer, once: "† forecast from ETH history <period> (n ≈ <n> per horizon), not a guarantee". */
export function forecastFooter(t: TouchTable, assets: readonly HistoryAsset[], direction: Direction): string {
  const n = Math.round(assets.reduce((a, x) => a + meanN(t, x, direction), 0) / assets.length / 10) * 10
  return `† forecast from ${assets.join(' and ')} history ${periodYears(t)} (n ≈ ${fmtInt(n)} per horizon), not a guarantee`
}

/**
 * Every leg the model moves, named, and every leg it holds. A ratio holds its quote by
 * definition, so the quote is not listed as held. Null when one price moves alone, or
 * when nothing is held at all (the same asset on both sides: the hero says why).
 */
export function assumptionOf(model: LineModel | null, basis: RiskBasis): string | null {
  if (!model) return null
  const moving = model.moving
  const held = model.held
  if (basis.kind === 'history') {
    const parts: string[] = []
    if (moving.length > 1) parts.push(`${moving.join(', ')} move together`)
    if (held.length > 0) parts.push(`${held.join(', ')} held at today's price`)
    return parts.length ? parts.join('; ') : null
  }
  if (moving.length === 0) return null
  // The moving asset's own debt moves with it: say so, so no moving leg goes unnamed.
  const sides = model.Wm > 0 && model.Dm > 0 ? ' collateral and debt' : model.Wm > 0 ? '' : ' debt'
  const verb = sides === ' collateral and debt' || moving.length > 1 ? 'move' : 'moves'
  const lead = `${moving.join(', ')}${sides} ${verb}`
  if (basis.kind === 'ratio') {
    const others = held.filter((x) => x !== basis.quote)
    return `${lead} against ${basis.quote}${others.length ? `; ${others.join(', ')} held at today's price` : ''}`
  }
  return held.length > 0 ? `${lead}; ${held.join(', ')} held at today's price` : null
}

function horizonForecast(
  t: TouchTable,
  s: MappedSnapshot['snapshot'],
  model: LineModel,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  level: number | null,
  borrowApr: number | null,
): HorizonForecast {
  const { rows: actions, ...solve } = reverseSolve(s, model, t, asset, horizon, borrowApr)
  const marks = [level, ...actions.map((a) => a.newDistancePct)].filter((x): x is number => x !== null)
  const from = Math.max(t.levels.min, Math.min(CURVE_RANGE.from, ...marks))
  const to = Math.min(t.levels.max, Math.max(CURVE_RANGE.to, ...marks))
  return {
    horizon,
    at: level === null ? null : touchAtLevel(t, asset, direction, horizon, level),
    curve: touchCurve(t, asset, direction, horizon, from, to),
    range: { from, to },
    actions,
    solve,
    confidence: confidenceOf(t, asset, direction, horizon),
  }
}

export function buildPositionView(p: ProtocolPosition, t: TouchTable): PositionView {
  const mapped = toSnapshot(p)
  const metrics = computeMetrics(mapped.snapshot)
  const basis = classifyRisk(mapped.snapshot)
  const model = lineModel(mapped.snapshot, basis)
  // Legs that do not reproduce the protocol's thresholds give no line at all: the hero
  // shows the protocol's own health factor and says why (snapshot.ts checkSplit).
  const hero: Hero = mapped.split.ok
    ? heroOf(model)
    : p.totalDebtUsd > 0
      ? { kind: 'unsplit', healthFactor: p.healthFactor, reason: mapped.split.reason ?? '' }
      : { kind: 'no-debt' }
  const distance =
    hero.kind === 'unsplit'
      ? hero.healthFactor > 1
        ? 1 - 1 / hero.healthFactor
        : 0
      : model
        ? lineDistance(model)
        : Number.POSITIVE_INFINITY
  // The buffer accrues at the dearest debt leg's rate the read reports, else the fallback.
  const aprs = p.debt.map((d) => d.borrowApr).filter((x): x is number => x !== null)
  const borrowApr = aprs.length === p.debt.length && aprs.length > 0 ? Math.max(...aprs) : null

  let forecast: ForecastView | null = null
  let forecastAbsent: string | null = null
  let alert: AlertInputs | null = null
  if (hero.kind === 'unsplit') {
    forecastAbsent = 'Thresholds could not be split per asset.'
  } else if (hero.kind !== 'no-debt') {
    if (basis.kind === 'history' && model) {
      // The reader's chance is read at the hero's own floored distance. Past the line, or
      // with no price that reaches it, there is no distance to forecast; the levers still solve.
      const lookup: TouchLookup['kind'] =
        hero.kind === 'line' ? lookupTouch(t, basis.asset, basis.direction, '7d', hero.distance).kind : 'within'
      const level = hero.kind === 'line' && lookup === 'row' ? hero.distancePct : null
      const byHorizon = Object.fromEntries(
        HORIZON_IDS.map((h) => [
          h,
          horizonForecast(t, mapped.snapshot, model, basis.asset, basis.direction, h, level, borrowApr),
        ]),
      ) as Record<HorizonId, HorizonForecast>
      forecast = {
        asset: basis.asset,
        direction: basis.direction,
        label: HISTORY_LABEL[basis.asset],
        level: hero.kind === 'line' ? hero.distancePct : 0,
        lookup: hero.kind === 'past' ? 'within' : hero.kind === 'unreachable' ? 'beyond' : lookup,
        byHorizon,
        years: periodYears(t),
        footer: forecastFooter(t, [basis.asset], basis.direction),
        credit: creditLine(t, basis.asset, basis.direction),
        creditShort: creditShort(t, basis.asset, basis.direction),
      }
      if (hero.kind === 'line') {
        const ref = referencePriceFrom(p, basis.asset)
        alert = {
          asset: basis.asset,
          direction: basis.direction,
          distance: hero.distance,
          referencePrice: ref,
          referenceSource: ref !== null ? priceSourceOf(p) : 'Aave V3 oracle',
        }
      }
    } else if (basis.kind !== 'history') {
      // dominant: no single history; ratio: the line is not on the USD axis at all.
      forecastAbsent = basis.reason
    }
  }

  const legs = legSymbols(mapped.snapshot)
  const pair = `${legs.collateral.join(' + ') || '—'} / ${legs.debt.join(' + ') || 'no debt'}`
  // Morpho labels already name the market; Compound names only its base (debt) asset.
  const title =
    p.protocol === 'morpho-blue'
      ? p.label
      : p.protocol === 'compound-v3'
        ? `${p.label} · ${legs.collateral.join(' + ') || '—'}`
        : `${p.label} · ${pair}`

  return {
    key: `${p.protocol}:${p.marketId ?? p.label}`,
    protocol: p.protocol,
    label: p.label,
    title,
    appUrl: PROTOCOL_APP_URL[p.protocol],
    priceSource: priceSourceOf(p),
    position: p,
    mapped,
    metrics,
    basis,
    model,
    hero,
    distance,
    forecast,
    forecastAbsent,
    alert,
    assumption: assumptionOf(model, basis),
  }
}

/** "line −23%" / "past the line" / "no debt" */
export function lineTag(v: PositionView): string {
  switch (v.hero.kind) {
    case 'line':
      return `line ${fmtMove(v.hero.distancePct, v.hero.direction)}`
    case 'past':
      return '✖ past the line'
    case 'unreachable':
      return v.hero.cause === 'interest' ? 'only interest moves the line' : 'no price reaches the line'
    case 'no-debt':
      return 'no debt'
    case 'unsplit':
      return `HF ${v.hero.healthFactor.toFixed(2)}`
  }
}

/** Nearest its line first: past the line, then smallest distance; a line no price reaches, then no debt, last. */
export function sortNearest(views: PositionView[]): PositionView[] {
  const rank = (v: PositionView) =>
    v.hero.kind === 'no-debt' ? Number.POSITIVE_INFINITY : v.hero.kind === 'unreachable' ? Number.MAX_VALUE : v.distance
  return [...views].sort((a, b) => rank(a) - rank(b))
}

// ------------------------------------------------------------------ the read

export type PageState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  /** Every adapter answered and nothing was found on a supported venue. */
  | { kind: 'none'; unsupported: string[]; failed: string[] }
  | { kind: 'positions'; views: PositionView[]; failed: string[]; unsupported: string[] }

/**
 * The page state from whatever has landed so far. Positions show as soon as one adapter
 * returns them; "none" waits until every adapter has answered.
 */
export function pageState(
  started: boolean,
  items: ReadStatusItem[],
  results: Partial<Record<ProtocolId, AdapterResult>>,
  t: TouchTable,
): PageState {
  if (!started) return { kind: 'idle' }
  const positions = Object.values(results).flatMap((r) => (r && r.status === 'ok' ? r.positions : []))
  const failed = items.filter((i) => i.state === 'error').map((i) => i.label)
  const unsupported = items.filter((i) => i.state === 'unsupported').map((i) => i.label)
  if (positions.length > 0) {
    return { kind: 'positions', views: sortNearest(positions.map((p) => buildPositionView(p, t))), failed, unsupported }
  }
  if (items.some((i) => i.state === 'pending')) return { kind: 'reading' }
  return { kind: 'none', unsupported, failed }
}

// ------------------------------------------------------------------ copy from constants

/** "4%" from MAX_THRESHOLD_TO_DELAY, the same construction as guarantee.ts's BAND. */
export const MEMBRANE_BAND = `${(MAX_THRESHOLD_TO_DELAY * 100).toFixed(0)}%`

/** DESIGN_RULES §4: the 8h is conditional. Never "8 hours before liquidation". */
export const MEMBRANE_LINE = `On Membrane: within ${MEMBRANE_BAND} of the line, liquidation waits ${CURE_WINDOW_HOURS} hours.`

/** The Membrane line and held-price assumptions are modelled (DESIGN_RULES §3 footer). */
export const MODELLED_FOOTER = '† modelled, not a guarantee'

/** Market-level distances shown before an address is read. */
export const MARKET_LEVELS = [10, 20, 30] as const
