/**
 * The borrower channel: the health-factor ladder (Q16) combined with the R27 "3% rule".
 *
 * Escalation order, lowest first (types.ts BORROWER_STEPS):
 *
 *   1 watch     HF below 1.30   in-app only (DEFAULT_PUSH_MIN_SEVERITY)
 *   2 warn      HF below 1.15   pushed
 *   3 critical  HF below 1.05   pushed
 *   4 at-risk   oracle price within 3% of the liquidation price (R27)   pushed, with subtext
 *   5 act-now   spot at or through the liquidation line                  pushed
 *
 * One message per step per episode. A step is sent only when it ranks above every step
 * already sent in the episode, so a borrower who got "at risk" does not then get "critical"
 * when the health factor catches up, and a sample that crosses several steps at once sends
 * only the highest. Other rules (depeg, cushion burn, exit capacity, oracle and governance
 * change) keep their own trackers and are not deduplicated here.
 *
 * An episode ends, and every step re-arms, when one of these is true (R27):
 *   moved-away    distance to the line is above AT_RISK_RULE.rearmDistance (10%)
 *   acted         a collateral amount went up or a debt amount went down
 *   liquidated    the caller says so
 *   ladder-clear  the health-factor tracker cleared (it recovered past 1.30 + band)
 *
 * Pure, like engine.ts: the caller owns the clock, the reads and the state store. No
 * probability is computed or shown anywhere in this module.
 */

import {
  ACT_NOW_EXPLAINER,
  AT_RISK_RULE,
  AT_RISK_SUBTEXT,
  MEMBRANE_LIQUIDATION,
  RECOVERED_TIMER_COPY,
  CORRELATED_LOOP_HF,
  DEFAULT_ALERT_CONFIG,
  DEFAULT_PUSH_MIN_SEVERITY,
  type AlertConfig,
  type AtRiskConfig,
} from './config'
import {
  evaluate,
  initialEngineState,
  isNotifiable,
  type EngineState,
  type Evaluation,
} from './engine'
import { fmtHf, fmtPct, fmtPrice } from './format'
import { computeMetrics } from './metrics'
import type { Rule } from './rules'
import { ALL_RULES } from './rules'
import type {
  Alert,
  BorrowerStep,
  CollateralInput,
  DebtInput,
  LiquidationTimer,
  MarketContext,
  PositionSnapshot,
} from './types'
import { levelOf, stepRank } from './types'

// ------------------------------------------------------------------ distance (k* rule)

/** USD stables and USD principal tokens. A hard-coded oracle also never moves. */
const USD_LIKE = /USD|DAI|GHO|FRAX|CDT/i

export const isStableLeg = (c: CollateralInput): boolean =>
  c.stable ??
  (c.peg?.class === 'stable' || c.oracleBasis === 'hardcoded' || USD_LIKE.test(c.symbol))

export const isStableDebt = (d: DebtInput): boolean => d.stable ?? USD_LIKE.test(d.symbol)

export interface LiquidationGeometry {
  /** LT-weighted collateral USD: stable legs, moving legs. */
  cStable: number
  cMoving: number
  /** Debt USD: stable, moving. */
  dStable: number
  dMoving: number
  /**
   * Price multiplier on every moving leg that puts health factor at exactly 1.
   * null when no uniform fall reaches the line (no debt, or moving debt ≥ moving collateral).
   */
  multiplierAtLine: number | null
  /** 1 − multiplierAtLine: the uniform fall that reaches the line. Negative = through it. */
  distance: number | null
  /** Every collateral leg and every debt leg is stable: a stable/PT loop. */
  correlatedLoop: boolean
  /** Moving collateral symbols, largest first. */
  movingSymbols: string[]
}

/**
 * The k* rule (r111v5_labels.py, branch research/history-forecasts): every non-stable
 * asset moves by the same factor, stables hold. Health factor reaches 1 when
 *   cStable + cMoving·m = dStable + dMoving·m   →   m = (dStable − cStable) / (cMoving − dMoving)
 * For one volatile collateral against a stable debt, distance = 1 − 1/HF.
 *
 * basis 'oracle' prices collateral at oraclePriceUsd (what liquidates; for Membrane the
 * deployed Oracle.getPrice). basis 'spot' uses marketPriceUsd (falls back to the oracle).
 */
export function liquidationGeometry(
  s: PositionSnapshot,
  basis: 'oracle' | 'spot' = 'oracle',
): LiquidationGeometry {
  let cStable = 0
  let cMoving = 0
  const moving: Array<[string, number]> = []
  for (const c of s.collateral) {
    const px = basis === 'spot' ? (c.marketPriceUsd ?? c.oraclePriceUsd) : c.oraclePriceUsd
    const w = c.amount * px * c.liquidationThreshold
    if (isStableLeg(c)) cStable += w
    else {
      cMoving += w
      if (c.amount > 0) moving.push([c.symbol, c.amount * px])
    }
  }
  let dStable = 0
  let dMoving = 0
  for (const d of s.debt) {
    const v = d.amount * d.priceUsd
    if (isStableDebt(d)) dStable += v
    else dMoving += v
  }
  const correlatedLoop = s.collateral.length > 0 && cMoving === 0 && dMoving === 0 && dStable > 0
  const denom = cMoving - dMoving
  const hasDebt = dStable + dMoving > 0
  const m = hasDebt && denom > 0 ? (dStable - cStable) / denom : null
  return {
    cStable,
    cMoving,
    dStable,
    dMoving,
    multiplierAtLine: m,
    distance: m === null ? null : 1 - m,
    correlatedLoop,
    movingSymbols: moving.sort((a, b) => b[1] - a[1]).map(([sym]) => sym),
  }
}

/**
 * Distance to the line a position WOULD have when its health factor reaches `hf` under the
 * same uniform fall. Puts the health-factor lines on the distance axis of the health bar.
 * One volatile leg: 1 − 1/hf (1.30 → 23.1%, 1.15 → 13.0%, 1.05 → 4.8%). null when no fall
 * reaches that health factor.
 */
export function distanceAtHealthFactor(g: LiquidationGeometry, hf: number): number | null {
  if (g.multiplierAtLine === null || !(g.multiplierAtLine > 0)) return null
  const denom = g.cMoving - hf * g.dMoving
  if (!(denom > 0)) return null
  const mh = (hf * g.dStable - g.cStable) / denom
  if (!(mh > 0)) return null
  return 1 - g.multiplierAtLine / mh
}

// ------------------------------------------------------------------ reading

export interface ProximityReading {
  /** Oracle-basis distance to the line (the 3% rule reads this). */
  distance: number | null
  /** Spot-basis distance (act now reads this). */
  spotDistance: number | null
  correlatedLoop: boolean
  /** Largest moving collateral leg: its oracle, spot and liquidation prices. */
  symbol: string | null
  oraclePriceUsd: number | null
  spotPriceUsd: number | null
  liquidationPriceUsd: number | null
  movingSymbols: string[]
  geometry: LiquidationGeometry
}

export function readProximity(s: PositionSnapshot): ProximityReading {
  const g = liquidationGeometry(s, 'oracle')
  const gs = liquidationGeometry(s, 'spot')
  const symbol = g.movingSymbols[0] ?? null
  const leg = symbol ? s.collateral.find((c) => c.symbol === symbol) : undefined
  const oracle = leg ? leg.oraclePriceUsd : null
  const spot = leg ? (leg.marketPriceUsd ?? leg.oraclePriceUsd) : null
  const m = g.multiplierAtLine
  return {
    distance: g.distance,
    spotDistance: gs.distance,
    correlatedLoop: g.correlatedLoop,
    symbol,
    oraclePriceUsd: oracle,
    spotPriceUsd: spot,
    liquidationPriceUsd: oracle !== null && m !== null && m > 0 ? oracle * m : null,
    movingSymbols: g.movingSymbols,
    geometry: g,
  }
}

// ------------------------------------------------------------------ borrower state

export type RearmReason = 'moved-away' | 'acted' | 'liquidated' | 'ladder-clear'

export interface ProximityState {
  /** The at-risk step may fire. */
  armed: boolean
  /** The act-now step may fire. */
  actNowArmed: boolean
  /** Rank (types.ts stepRank) of the highest step sent in this episode; 0 = none. */
  episodeRank: number
  lastEvalTs: number | null
  lastAmounts: { collateral: Record<string, number>; debt: Record<string, number> } | null
}

export interface BorrowerState {
  engine: EngineState
  proximity: ProximityState
}

export const initialProximityState = (): ProximityState => ({
  armed: true,
  actNowArmed: true,
  episodeRank: 0,
  lastEvalTs: null,
  lastAmounts: null,
})

export const initialBorrowerState = (): BorrowerState => ({
  engine: initialEngineState(),
  proximity: initialProximityState(),
})

export interface BorrowerEvaluation {
  /** The ladder engine's own output, unchanged. */
  evaluation: Evaluation
  /** Every alert this sample: engine alerts (HF ones tagged with a step) plus at-risk / act-now. */
  alerts: Alert[]
  /** What the borrower sees in-app (watch and up), after the per-episode dedup. */
  inApp: Alert[]
  /** What would be pushed (DEFAULT_PUSH_MIN_SEVERITY and up), after the dedup. Dry run only. */
  push: Alert[]
  /** Step alerts held back because an equal or higher step was already sent this episode. */
  deduped: Alert[]
  reading: ProximityReading
  rearmed: RearmReason[]
  /** Seconds since the previous evaluation; null on the first. */
  cadenceGapS: number | null
  /** False when the gap broke the "at least hourly" rule (the caller's scheduler lagged). */
  cadenceOk: boolean
  state: BorrowerState
}

const amountsOf = (s: PositionSnapshot) => ({
  collateral: Object.fromEntries(s.collateral.map((c) => [c.symbol, c.amount])),
  debt: Object.fromEntries(s.debt.map((d) => [d.symbol, d.amount])),
})

const EPS = 1e-9

/** A collateral amount went up or a debt amount went down since the last sample. */
function borrowerActed(prev: ProximityState['lastAmounts'], s: PositionSnapshot): boolean {
  if (!prev) return false
  const up = s.collateral.some((c) => c.amount > (prev.collateral[c.symbol] ?? 0) * (1 + EPS) + EPS)
  const repaid = Object.entries(prev.debt).some(([sym, was]) => {
    const now = s.debt.find((d) => d.symbol === sym)?.amount ?? 0
    return now < was * (1 - EPS) - EPS
  })
  return up || repaid
}

/** True when the 3% rule is due again: it must run at least every evaluationIntervalS. */
export function isAtRiskCheckDue(
  st: ProximityState,
  nowTs: number,
  cfg: AtRiskConfig = AT_RISK_RULE,
): boolean {
  return st.lastEvalTs === null || nowTs - st.lastEvalTs >= cfg.evaluationIntervalS
}

const HF_STEP: Record<1 | 2 | 3, BorrowerStep> = { 1: 'watch', 2: 'warn', 3: 'critical' }

function atRiskAlert(
  s: PositionSnapshot,
  r: ProximityReading,
  hf: number,
  cfg: AtRiskConfig,
): Alert {
  const d = r.distance as number
  const liq = r.liquidationPriceUsd
  const prices =
    r.oraclePriceUsd !== null && liq !== null
      ? `${r.symbol} oracle ${fmtPrice(r.oraclePriceUsd)}, liquidation at ${fmtPrice(liq)}. `
      : ''
  const what =
    r.movingSymbols.length > 1
      ? ` A ${fmtPct(d)} fall in ${r.movingSymbols.join(', ')} reaches it.`
      : ''
  return {
    positionId: s.id,
    ruleId: 'at-risk',
    key: 'distance',
    transition: 'fire',
    from: 0,
    to: 3,
    severity: 'critical',
    peak: 3,
    ts: s.ts,
    value: d,
    threshold: cfg.threshold,
    title: `At risk: ${fmtPct(d)} from liquidation`,
    detail: `${prices}Health factor ${fmtHf(hf)}.${what}`,
    evidence: {
      distance: d,
      spotDistance: r.spotDistance,
      oraclePrice: r.oraclePriceUsd,
      liquidationPrice: liq,
      healthFactor: hf,
      basis: 'oracle',
    },
    step: 'at-risk',
    subtext: AT_RISK_SUBTEXT.text,
  }
}

const utcMinute = (ts: number) =>
  new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

export const isMembraneVenue = (venue: string): boolean => /^membrane\b/i.test(venue)

/** What the act-now copy needs from outside the position (stub hooks; see types.ts). */
export type TimerContext = Pick<MarketContext, 'liquidationTimer' | 'liquidationWindow'>

/**
 * Membrane immediate-liquidation price X = P / (1 + window), window from chain state
 * (ctx.liquidationWindow; launch default until a reader exists). A started timer's own
 * value wins when the event carries one.
 */
export function immediateLiquidationPrice(
  liquidationPriceUsd: number | null,
  ctx: TimerContext = {},
): number | null {
  const fromTimer = ctx.liquidationTimer?.immediateLiquidationPriceUsd
  if (fromTimer != null) return fromTimer
  if (liquidationPriceUsd === null) return null
  const w = ctx.liquidationWindow ?? MEMBRANE_LIQUIDATION.launchWindow
  return w >= 0 ? liquidationPriceUsd / (1 + w) : null
}

/** The R29 explainer with P and X filled; the X sentence is dropped when X is unknown. */
export function actNowExplainer(p: number | null, x: number | null): string {
  const parts = [ACT_NOW_EXPLAINER.oracle.replace('{P}', p !== null ? fmtPrice(p) : 'n/a')]
  if (x !== null) parts.push(ACT_NOW_EXPLAINER.immediate.replace('{X}', fmtPrice(x)))
  parts.push(ACT_NOW_EXPLAINER.history)
  return parts.join(' ')
}

/**
 * The "timer started" line (STUB: fed by a future LiquidationTimerStarted reader): start and
 * expiry only. It never says how long the borrower has.
 */
export function timerLine(t: LiquidationTimer): string {
  return `Liquidation timer started ${utcMinute(t.startedTs)}, expires ${utcMinute(t.expiresTs)}.`
}

export interface ActNowCopy {
  title: string
  detail: string
  /** Oracle back above the line while a started timer still runs (post-recovery stub). */
  recoveredTimer: boolean
  immediatePriceUsd: number | null
}

/**
 * Act-now wording. Fires at the oracle line crossing itself (or spot through the line), not
 * only on LiquidationTimerStarted: keepers get no reward for starting the timer, so the
 * event can be late. Membrane positions get the R29 explainer; other venues a plain line.
 */
export function actNowCopy(
  venue: string,
  r: Pick<
    ProximityReading,
    | 'symbol'
    | 'movingSymbols'
    | 'distance'
    | 'liquidationPriceUsd'
    | 'spotPriceUsd'
    | 'oraclePriceUsd'
  >,
  hf: number,
  ctx: TimerContext = {},
): ActNowCopy {
  const timer = ctx.liquidationTimer ?? null
  const membrane = isMembraneVenue(venue)
  const liq = r.liquidationPriceUsd
  const x = membrane ? immediateLiquidationPrice(liq, ctx) : null
  const recoveredTimer = timer !== null && r.distance !== null && r.distance > 0
  if (recoveredTimer)
    return {
      title: RECOVERED_TIMER_COPY.title,
      detail: `${timerLine(timer)} ${RECOVERED_TIMER_COPY.note}`,
      recoveredTimer,
      immediatePriceUsd: x,
    }
  const subject =
    r.movingSymbols.length > 1 ? `a uniform fall in ${r.movingSymbols.join(', ')}` : `${r.symbol}`
  const prices =
    r.spotPriceUsd !== null && liq !== null
      ? `${r.spotPriceUsd !== r.oraclePriceUsd ? 'Spot' : 'Oracle'} ${r.symbol} ${fmtPrice(r.spotPriceUsd)}, liquidation at ${fmtPrice(liq)}. `
      : ''
  const why = membrane
    ? `${actNowExplainer(liq, x)}${timer ? ` ${timerLine(timer)}` : ''}`
    : 'Liquidation can start at any time.'
  return {
    title: timer ? 'Liquidation timer started' : `${subject} at or through your liquidation price`,
    detail: `${prices}Health factor ${fmtHf(hf)}. ${why} Repay or add collateral now.`,
    recoveredTimer,
    immediatePriceUsd: x,
  }
}

function actNowAlert(
  s: PositionSnapshot,
  r: ProximityReading,
  hf: number,
  ctx: TimerContext = {},
): Alert {
  const timer = ctx.liquidationTimer ?? null
  const copy = actNowCopy(s.venue, r, hf, ctx)
  return {
    positionId: s.id,
    ruleId: 'act-now',
    key: 'line',
    transition: 'fire',
    from: 0,
    to: 3,
    severity: 'critical',
    peak: 3,
    ts: s.ts,
    value: (r.spotDistance ?? r.distance ?? 0) as number,
    threshold: 0,
    title: `Act now: ${copy.title}`,
    detail: copy.detail,
    evidence: {
      spotDistance: r.spotDistance,
      distance: r.distance,
      spotPrice: r.spotPriceUsd,
      liquidationPrice: r.liquidationPriceUsd,
      immediateLiquidationPrice: copy.immediatePriceUsd,
      healthFactor: hf,
      basis: timer ? 'liquidation-timer' : 'line-crossing',
      timerStartedTs: timer?.startedTs ?? null,
      timerExpiresTs: timer?.expiresTs ?? null,
      recoveredTimer: copy.recoveredTimer ? 1 : 0,
    },
    step: 'act-now',
  }
}

export interface BorrowerOptions {
  /** The position was liquidated since the last sample (from the venue's events). */
  liquidated?: boolean
}

/**
 * One borrower sample: the ladder engine, then the 3% rule, then the per-episode dedup.
 * Delivery stays dry-run: format `push` with telegram.ts formatPositionAlert and
 * dryRunTelegram; nothing here sends.
 */
export function evaluateBorrower(
  snapshot: PositionSnapshot,
  ctx: MarketContext = {},
  state: BorrowerState = initialBorrowerState(),
  config: AlertConfig = DEFAULT_ALERT_CONFIG,
  opts: BorrowerOptions = {},
  rules: readonly Rule[] = ALL_RULES,
): BorrowerEvaluation {
  const cfg = config.atRisk === undefined ? AT_RISK_RULE : config.atRisk
  const evaluation = evaluate(snapshot, ctx, state.engine, config, rules)
  const reading = readProximity(snapshot)
  const hf = evaluation.metrics.healthFactor
  let p = { ...state.proximity }

  const cadenceGapS = p.lastEvalTs === null ? null : snapshot.ts - p.lastEvalTs
  const cadenceOk = cadenceGapS === null || !cfg || cadenceGapS <= cfg.evaluationIntervalS

  // Tag the ladder's health-factor alerts with their borrower step.
  const engineAlerts = evaluation.alerts.map((a) =>
    a.ruleId === 'health-factor' && levelOf(a.severity) > 0
      ? { ...a, step: HF_STEP[levelOf(a.severity) as 1 | 2 | 3] }
      : a,
  )

  // ---- re-arm (R27): before this sample's steps are judged
  const rearmed: RearmReason[] = []
  if (opts.liquidated) rearmed.push('liquidated')
  if (borrowerActed(p.lastAmounts, snapshot)) rearmed.push('acted')
  const rearmAt = cfg?.rearmDistance ?? AT_RISK_RULE.rearmDistance
  if (reading.distance === null ? !reading.correlatedLoop : reading.distance > rearmAt)
    rearmed.push('moved-away')
  if (engineAlerts.some((a) => a.ruleId === 'health-factor' && a.transition === 'clear'))
    rearmed.push('ladder-clear')
  const inEpisode = p.episodeRank > 0 || !p.armed || !p.actNowArmed
  if (rearmed.length && inEpisode) p = { ...p, armed: true, actNowArmed: true, episodeRank: 0 }

  // ---- candidate steps this sample
  const candidates: Alert[] = []
  for (const a of engineAlerts)
    if (a.step && (a.transition === 'fire' || a.transition === 'escalate')) candidates.push(a)
  const ruleOn = cfg !== null && !reading.correlatedLoop
  const timer = ctx.liquidationTimer ?? null
  // Act now at the line crossing itself: oracle (Membrane: the 1-hour average) or spot.
  const through =
    (reading.spotDistance !== null && reading.spotDistance <= 0) ||
    (reading.distance !== null && reading.distance <= 0)
  if (ruleOn && p.actNowArmed && (through || timer))
    candidates.push(actNowAlert(snapshot, reading, hf, ctx))
  if (
    ruleOn &&
    p.armed &&
    reading.distance !== null &&
    reading.distance <= (cfg as AtRiskConfig).threshold
  )
    candidates.push(atRiskAlert(snapshot, reading, hf, cfg as AtRiskConfig))

  // ---- dedup: only the highest step, and only if it outranks the episode so far
  const top = candidates.reduce<Alert | null>(
    (m, a) => (m === null || stepRank(a.step!) > stepRank(m.step!) ? a : m),
    null,
  )
  const sent = top && stepRank(top.step!) > p.episodeRank ? top : null
  const deduped = candidates.filter((a) => a !== sent)
  if (sent) {
    const r = stepRank(sent.step!)
    p = {
      ...p,
      episodeRank: r,
      armed: p.armed && r < stepRank('at-risk'),
      actNowArmed: p.actNowArmed && r < stepRank('act-now'),
    }
  }

  const proximityAlerts = candidates.filter((a) => a.ruleId === 'at-risk' || a.ruleId === 'act-now')
  const alerts = [...engineAlerts, ...proximityAlerts]
  const held = new Set(deduped)
  const inApp = alerts.filter((a) => !held.has(a) && isNotifiable(a, 'watch'))
  const push = alerts.filter((a) => !held.has(a) && isNotifiable(a, DEFAULT_PUSH_MIN_SEVERITY))

  p = { ...p, lastEvalTs: snapshot.ts, lastAmounts: amountsOf(snapshot) }
  return {
    evaluation,
    alerts,
    inApp,
    push,
    deduped,
    reading,
    rearmed,
    cadenceGapS,
    cadenceOk,
    state: { engine: evaluation.state, proximity: p },
  }
}

// ------------------------------------------------------------------ health bar model

export type BarState =
  | 'clear'
  | 'watch'
  | 'warn'
  | 'critical'
  | 'at-risk'
  | 'act-now'
  | 'no-debt'
  | 'loop'

export interface BarMarker {
  id: BorrowerStep
  label: string
  /** Health factor of the line, for the ladder markers. */
  hf: number | null
  /** Where the line sits on the distance axis, 0–1. */
  distance: number
}

export interface HealthBarModel {
  state: BarState
  distance: number | null
  spotDistance: number | null
  healthFactor: number
  symbol: string | null
  movingSymbols: string[]
  oraclePriceUsd: number | null
  spotPriceUsd: number | null
  liquidationPriceUsd: number | null
  /** Markers, nearest the line first. act-now is the line itself (0). */
  markers: BarMarker[]
  /** Distance axis, fractions. min < 0 leaves room for the act-now zone. */
  axis: { min: number; max: number }
  /** The current position lies past axis.max (drawn pinned at the right edge). */
  offScale: boolean
  /** A started Membrane liquidation timer (stub hook; null until a chain reader exists). */
  timer: LiquidationTimer | null
  /** Membrane immediate-liquidation price X (chain-state window; launch default until read). */
  immediatePriceUsd: number | null
  /** Act-now wording when state is act-now (R29 explainer, timer, post-recovery stub). */
  actNow: ActNowCopy | null
  /** Plain-text equivalent of the bar for screen readers and the dry-run message. */
  summary: string
}

export const HEALTH_BAR_AXIS_MIN = -0.05
const AXIS_MAX_DEFAULT = 0.4

const STATE_WORD: Record<BarState, string> = {
  clear: 'clear',
  watch: 'watch',
  warn: 'warn',
  critical: 'critical',
  'at-risk': 'at risk',
  'act-now': 'act now',
  'no-debt': 'no debt',
  loop: 'stable/PT loop',
}

/**
 * Everything the always-visible health bar draws, from one snapshot. Instantaneous: it
 * shows where the position stands against every line, not which messages were sent.
 * Numbers only: no probability, no confidence figure.
 */
export function healthBarModel(
  s: PositionSnapshot,
  config: AlertConfig = DEFAULT_ALERT_CONFIG,
  ctx: TimerContext = {},
): HealthBarModel {
  const timer = ctx.liquidationTimer ?? null
  const r = readProximity(s)
  const hf = computeMetrics(s).healthFactor
  const cfg = config.atRisk === undefined ? AT_RISK_RULE : config.atRisk
  const ladder = config.healthFactor?.enter ?? {}

  const markers: BarMarker[] = [{ id: 'act-now', label: 'Act now', hf: null, distance: 0 }]
  if (cfg && !r.correlatedLoop)
    markers.push({ id: 'at-risk', label: 'At risk', hf: null, distance: cfg.threshold })
  for (const [id, label] of [
    ['critical', 'Critical'],
    ['warn', 'Warn'],
    ['watch', 'Watch'],
  ] as const) {
    const line = ladder[id]
    if (line === undefined) continue
    const d = distanceAtHealthFactor(r.geometry, line)
    if (d !== null) markers.push({ id, label, hf: line, distance: d })
  }
  markers.sort((a, b) => a.distance - b.distance)

  let state: BarState
  if (!(r.geometry.dStable + r.geometry.dMoving > 0)) state = 'no-debt'
  else if (r.correlatedLoop) state = 'loop'
  else if (
    timer ||
    (r.spotDistance !== null && r.spotDistance <= 0) ||
    (r.distance !== null && r.distance <= 0)
  )
    state = 'act-now'
  else if (cfg && r.distance !== null && r.distance <= cfg.threshold) state = 'at-risk'
  else if (ladder.critical !== undefined && hf < ladder.critical) state = 'critical'
  else if (ladder.warn !== undefined && hf < ladder.warn) state = 'warn'
  else if (ladder.watch !== undefined && hf < ladder.watch) state = 'watch'
  else state = 'clear'

  const farthest = markers.reduce((m, k) => Math.max(m, k.distance), 0)
  const max = Math.min(1, Math.max(AXIS_MAX_DEFAULT, farthest + 0.05))
  const offScale = r.distance !== null && r.distance > max

  const parts: string[] = []
  if (state === 'no-debt') parts.push('No debt: nothing to liquidate.')
  else if (state === 'loop')
    parts.push(
      `Stable/PT loop: priced near its line by design, so the 3% rule does not apply. Health factor ${fmtHf(hf)}; correlated-loop lines HF ${CORRELATED_LOOP_HF.enter.watch} / ${CORRELATED_LOOP_HF.enter.warn} / ${CORRELATED_LOOP_HF.enter.critical}.`,
    )
  else {
    parts.push(
      r.distance === null
        ? 'No uniform price fall reaches the liquidation line.'
        : `${fmtPct(r.distance)} from liquidation (oracle price), state ${STATE_WORD[state]}.`,
    )
    if (r.symbol && r.oraclePriceUsd !== null)
      parts.push(
        `${r.symbol} oracle ${fmtPrice(r.oraclePriceUsd)}` +
          (r.liquidationPriceUsd !== null
            ? `, liquidation at ${fmtPrice(r.liquidationPriceUsd)}`
            : '') +
          (r.spotPriceUsd !== null && r.spotPriceUsd !== r.oraclePriceUsd
            ? `, spot ${fmtPrice(r.spotPriceUsd)}`
            : '') +
          '.',
      )
    if (r.movingSymbols.length > 1)
      parts.push(`Distance is the same fall in ${r.movingSymbols.join(', ')}; stables held.`)
    parts.push(`Health factor ${fmtHf(hf)}.`)
    parts.push(
      'Lines: ' +
        markers
          .map((m) =>
            m.id === 'act-now'
              ? 'act now at the line (spot)'
              : `${m.label.toLowerCase()} ${fmtPct(m.distance)}${m.hf !== null ? ` (HF ${m.hf.toFixed(2)})` : ''}`,
          )
          .join(', ') +
        '.',
    )
  }

  return {
    state,
    distance: r.distance,
    spotDistance: r.spotDistance,
    healthFactor: hf,
    symbol: r.symbol,
    movingSymbols: r.movingSymbols,
    oraclePriceUsd: r.oraclePriceUsd,
    spotPriceUsd: r.spotPriceUsd,
    liquidationPriceUsd: r.liquidationPriceUsd,
    markers,
    axis: { min: HEALTH_BAR_AXIS_MIN, max },
    offScale,
    timer,
    immediatePriceUsd: isMembraneVenue(s.venue)
      ? immediateLiquidationPrice(r.liquidationPriceUsd, ctx)
      : null,
    actNow: state === 'act-now' ? actNowCopy(s.venue, r, hf, ctx) : null,
    summary: (timer ? [...parts, timerLine(timer)] : parts).join(' '),
  }
}

// ------------------------------------------------------------------ in-app notice

export interface InAppNotice {
  step: BorrowerStep
  tag: string
  title: string
  detail: string
  /** The past-data line under an at-risk alert (AT_RISK_SUBTEXT); null otherwise. */
  subtext: string | null
  /**
   * Post-recovery stub: the clearRecoveredTimer placeholder. Always disabled until the owner
   * decides; no transaction is wired.
   */
  action: { id: string; label: string; enabled: false; note: string } | null
}

const NOTICE_TAG: Record<BorrowerStep, string> = {
  watch: 'Watch',
  warn: 'Warn',
  critical: 'Critical',
  'at-risk': 'At risk',
  'act-now': 'Act now',
}

/**
 * The notice the health bar shows above itself. From the borrower's latest in-app alert
 * when the caller has one; otherwise derived from the bar's own state for the two steps a
 * borrower must not miss (at risk, act now). Watch / warn / critical without an alert show
 * no notice: the bar already marks them.
 */
export function inAppNotice(model: HealthBarModel, alert?: Alert | null): InAppNotice | null {
  if (alert?.step) {
    return {
      step: alert.step,
      tag: NOTICE_TAG[alert.step],
      title: alert.title,
      detail: alert.detail,
      subtext: alert.subtext ?? (alert.step === 'at-risk' ? AT_RISK_SUBTEXT.text : null),
      action: alert.evidence.recoveredTimer === 1 ? recoveredAction() : null,
    }
  }
  const prices =
    model.symbol && model.oraclePriceUsd !== null && model.liquidationPriceUsd !== null
      ? `${model.symbol} oracle ${fmtPrice(model.oraclePriceUsd)}, liquidation at ${fmtPrice(model.liquidationPriceUsd)}. `
      : ''
  if (model.state === 'act-now' && model.actNow)
    return {
      step: 'act-now',
      tag: model.actNow.recoveredTimer ? 'Timer running' : NOTICE_TAG['act-now'],
      title: model.actNow.title,
      detail: model.actNow.detail,
      subtext: null,
      action: model.actNow.recoveredTimer ? recoveredAction() : null,
    }
  if (model.state === 'at-risk' && model.distance !== null)
    return {
      step: 'at-risk',
      tag: NOTICE_TAG['at-risk'],
      title: `${fmtPct(model.distance)} from liquidation`,
      detail: `${prices}Health factor ${fmtHf(model.healthFactor)}.`,
      subtext: AT_RISK_SUBTEXT.text,
      action: null,
    }
  return null
}

const recoveredAction = () => ({
  id: RECOVERED_TIMER_COPY.action.id,
  label: RECOVERED_TIMER_COPY.action.label,
  enabled: false as const,
  note: RECOVERED_TIMER_COPY.note,
})
