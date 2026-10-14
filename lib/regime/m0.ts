/**
 * M0 — the market regime, calm or choppy. A FIXED rule (owner, board Q27; MODELS_PLAN M0):
 * no fit, no tuning, no probability.
 *
 *   Choppy if EITHER
 *     (A) the ETH 24h move is at or past its historical p95:
 *         |oracle_t / oracle_{t−24h} − 1| ≥ move24hP95
 *     (B) Chainlink is outside its band against the market:
 *         |oracle_t / market_t − 1| ≥ gapBand   (p99.9 of the same statistic)
 *   and it HOLDS: once a trigger fires, the state stays choppy until 24h after the last
 *   hour that fired.
 *
 *   Liquidation volume ≥ p95 is part of the owner's rule only where a live source exists.
 *   None does (only a static corpus), so it is omitted and the result says so.
 *
 * Inputs follow the price-history convention: one value per hour, stamped at the hour END
 * (`t`, unix ms, on the hour). oracle = the Chainlink ETH/USD answer in force at t; market =
 * the Coinbase ETH-USD 1h candle that closed at t. null = no observation; nothing is filled.
 * Thresholds come from lib/regime/m0Thresholds.generated.json (lib/regime/thresholds.ts).
 *
 * Stateless: the hold is recomputed from the last 48 hourly points on every call, so the
 * server needs no memory of earlier calls. Pure: no I/O, no clock — `nowMs` is an input.
 */

import type { M0Thresholds } from './thresholds'

export const HOUR_MS = 3_600_000
/** The hours the rule looks back over: the hold, plus the hold's own lookback for (A). */
export const M0_EVAL_HOURS = 48
/** The coverage test: at least 20 of the last 24 completed hours carry both inputs. */
export const M0_COVERAGE_WINDOW = 24
export const M0_MIN_COVERAGE = 20
/** Two Chainlink heartbeats (ETH/USD heartbeat 1h). An input older than this is stale. */
export const M0_MAX_INPUT_AGE_MS = 2 * HOUR_MS

export interface HourlyPoint {
  /** Hour END, unix ms, on the hour. */
  t: number
  v: number | null
}

export type M0TriggerKind = 'move24h' | 'oracleGap'

export interface M0Trigger {
  t: number
  kind: M0TriggerKind
  /** Signed: move = oracle_t / oracle_{t−24h} − 1; gap = oracle_t / market_t − 1. */
  value: number
  threshold: number
}

export type M0StaleReason = 'oracleOld' | 'marketOld' | 'lowCoverage'

export interface M0Reading {
  t: number
  /** Signed, as in M0Trigger. */
  value: number
}

export interface M0Result {
  state: 'calm' | 'choppy' | 'stale'
  /** Hour end of the latest completed hour, the last hour the rule evaluates. */
  evaluatedAt: number
  holdHours: number
  /** Every trigger in the evaluated window, oldest first (move before gap within an hour). */
  triggers: M0Trigger[]
  /** The latest completed hour itself fired (false while choppy only by the hold). */
  active: boolean
  /** The newest computable reading of each statistic within the last 24 completed hours. */
  current: { move24h: M0Reading | null; gap: M0Reading | null }
  /** First triggering hour of the current choppy run; null when no run is current. */
  since: number | null
  /** The run may have begun before the window the rule can see; `since` is then the
   *  earliest hour it saw. "Choppy since `since`" stays true either way. */
  sinceTruncated: boolean
  /** Last triggering hour + holdHours; null when no run is current. */
  holdsUntil: number | null
  /** Newest trigger in the window, current run or not. */
  lastTriggerAt: number | null
  coverage: { hoursObserved: number; window: number; required: number }
  inputs: { oracleAsOf: number | null; marketAsOf: number | null }
  /** Every stale condition that holds, whatever the state (the dateline shows ages). */
  stale: M0StaleReason[]
  liquidationVolume: { counted: false; reason: 'no live source' }
}

export interface M0Input {
  oracle: HourlyPoint[]
  market: HourlyPoint[]
  nowMs: number
  thresholds: M0Thresholds
  holdHours?: number
  /** updatedAt of the newest oracle round read (ms). Defaults to the newest observed
   *  oracle hour at or before now. */
  oracleAsOfMs?: number | null
  /** Close time of the newest market candle (ms). Defaults to the newest observed market
   *  hour at or before now. */
  marketAsOfMs?: number | null
}

const usable = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0

/** Observed values by hour end. Off-grid points and points after `lastHour` are dropped:
 *  an hour that has not ended has no close. */
function byHour(points: HourlyPoint[], lastHour: number): Map<number, number> {
  const m = new Map<number, number>()
  for (const p of points) {
    if (p.t % HOUR_MS !== 0 || p.t > lastHour || !usable(p.v)) continue
    m.set(p.t, p.v)
  }
  return m
}

const newest = (m: Map<number, number>): number | null => {
  let best: number | null = null
  for (const t of m.keys()) if (best === null || t > best) best = t
  return best
}

export function evaluateM0(input: M0Input): M0Result {
  const { nowMs, thresholds } = input
  const holdHours = input.holdHours ?? 24
  const holdMs = holdHours * HOUR_MS
  const H = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  const windowStart = H - (M0_EVAL_HOURS - 1) * HOUR_MS
  const recentStart = H - (holdHours - 1) * HOUR_MS
  const coverageStart = H - (M0_COVERAGE_WINDOW - 1) * HOUR_MS

  const O = byHour(input.oracle, H)
  const M = byHour(input.market, H)

  const triggers: M0Trigger[] = []
  let move24h: M0Reading | null = null
  let gap: M0Reading | null = null
  let hoursObserved = 0

  // A missing hour is simply not evaluated: it neither fires nor counts as calm. So a
  // trigger that IS observed still counts when other hours are missing.
  for (let t = windowStart; t <= H; t += HOUR_MS) {
    const o = O.get(t)
    const c = M.get(t)
    if (t >= coverageStart && o !== undefined && c !== undefined) hoursObserved++
    if (o === undefined) continue
    const prev = O.get(t - 24 * HOUR_MS)
    if (prev !== undefined) {
      const value = o / prev - 1
      if (t >= coverageStart) move24h = { t, value }
      if (Math.abs(value) >= thresholds.move24hP95) {
        triggers.push({ t, kind: 'move24h', value, threshold: thresholds.move24hP95 })
      }
    }
    if (c !== undefined) {
      const value = o / c - 1
      if (t >= coverageStart) gap = { t, value }
      if (Math.abs(value) >= thresholds.gapBand) {
        triggers.push({ t, kind: 'oracleGap', value, threshold: thresholds.gapBand })
      }
    }
  }

  const lastTriggerAt = triggers.length ? triggers[triggers.length - 1].t : null
  const runIsCurrent = lastTriggerAt !== null && lastTriggerAt >= recentStart

  // The run: walk back through earlier triggers while each sits within the hold of the
  // next (a gap of exactly holdHours keeps it continuous: the hour the old hold ends is
  // the hour the new trigger fires).
  let since: number | null = null
  let sinceTruncated = false
  if (runIsCurrent) {
    const hours = [...new Set(triggers.map((x) => x.t))]
    since = hours[hours.length - 1]
    for (let i = hours.length - 2; i >= 0 && since - hours[i] <= holdMs; i--) since = hours[i]
    sinceTruncated = since - holdMs < windowStart
  }

  const oracleAsOf = input.oracleAsOfMs ?? newest(O)
  const marketAsOf = input.marketAsOfMs ?? newest(M)
  const stale: M0StaleReason[] = []
  const oracleOld = oracleAsOf === null || nowMs - oracleAsOf > M0_MAX_INPUT_AGE_MS
  if (oracleOld) stale.push('oracleOld')
  if (marketAsOf === null || nowMs - marketAsOf > M0_MAX_INPUT_AGE_MS) stale.push('marketOld')
  if (hoursObserved < M0_MIN_COVERAGE) stale.push('lowCoverage')

  // Precedence:
  //  1. An old oracle is stale, trigger or not. Its "answer in force" at recent hour ends
  //     could come from a lagging read, and against a live market that can INVENT a gap.
  //  2. An observed trigger in the hold window is choppy, even with hours missing or the
  //     market feed old: missing market hours can only hide a trigger, never make one,
  //     and the hold means no later hour could end the run before holdsUntil.
  //  3. Calm is a claim about every hour, so it needs a fresh market and the coverage.
  let state: M0Result['state']
  if (oracleOld) state = 'stale'
  else if (runIsCurrent) state = 'choppy'
  else if (stale.length) state = 'stale'
  else state = 'calm'

  return {
    state,
    evaluatedAt: H,
    holdHours,
    triggers,
    active: lastTriggerAt === H,
    current: { move24h, gap },
    since,
    sinceTruncated,
    holdsUntil: runIsCurrent ? (lastTriggerAt as number) + holdMs : null,
    lastTriggerAt,
    coverage: { hoursObserved, window: M0_COVERAGE_WINDOW, required: M0_MIN_COVERAGE },
    inputs: { oracleAsOf, marketAsOf },
    stale,
    liquidationVolume: { counted: false, reason: 'no live source' },
  }
}
