/**
 * The position-alert engine: one snapshot in, alerts and the next state out. Pure — the
 * caller owns the clock, the data reads and the state store.
 *
 *   const { alerts, state } = evaluate(snapshot, ctx, prevState)
 *
 * Each rule signal gets its own anti-flap tracker keyed `${ruleId}:${key}`. Whether an
 * alert is worth a message is a separate decision (isNotifiable) so the back-test can
 * score exactly what a borrower would have received.
 */

import { DEFAULT_ALERT_CONFIG, type AlertConfig } from './config'
import { initialTracker, stepLevel, validateSpec, type TrackerState } from './levels'
import { computeMetrics, type PositionMetrics } from './metrics'
import { ALL_RULES, type Rule } from './rules'
import type { Alert, MarketContext, PositionSnapshot, Severity } from './types'
import { levelOf, severityOf } from './types'

/** Health-factor history is kept as per-bucket maxima, at most ~60 buckets per lookback. */
export const HF_BUCKETS_PER_LOOKBACK = 60

export interface EngineState {
  trackers: Record<string, TrackerState>
  /** [bucketStartTs, maxHf], oldest first. */
  hfHistory: Array<[number, number]>
  /** [bucketStartTs, maxAvailableUsd], oldest first (exit-capacity burn). */
  capHistory?: Array<[number, number]>
}

export const initialEngineState = (): EngineState => ({
  trackers: {},
  hfHistory: [],
  capHistory: [],
})

export interface Evaluation {
  alerts: Alert[]
  state: EngineState
  metrics: PositionMetrics
  /** `${ruleId}:${key} — reason` for every signal that had no data this sample. */
  uncovered: string[]
}

/** Append a sample to a bucketed trailing-max history (health factor or capacity). */
function pushHf(
  history: Array<[number, number]>,
  ts: number,
  hf: number,
  lookbackS: number,
): Array<[number, number]> {
  if (!(lookbackS > 0) || !Number.isFinite(hf)) return history
  const bucket = Math.max(1, Math.floor(lookbackS / HF_BUCKETS_PER_LOOKBACK))
  const start = Math.floor(ts / bucket) * bucket
  const kept = history.filter(([t]) => t >= ts - lookbackS - bucket)
  const last = kept[kept.length - 1]
  if (last && last[0] === start) return [...kept.slice(0, -1), [start, Math.max(last[1], hf)]]
  return [...kept, [start, hf]]
}

/** Throws on a mis-ordered threshold set, so a bad config fails at load, not mid-crash. */
export function validateConfig(config: AlertConfig): void {
  const specs = [
    config.healthFactor,
    config.ltv,
    config.liquidationDistance?.spec,
    config.liquidationDistance?.sigmaSpec,
    config.cushionBurn?.spec,
    config.depeg?.stable,
    config.depeg?.lst,
    config.exitCapacity?.spec,
    config.exitCapacity?.burn?.spec,
    config.oracleChange?.spec,
  ]
  for (const s of specs) if (s) validateSpec(s)
}

export function evaluate(
  snapshot: PositionSnapshot,
  ctx: MarketContext = {},
  state: EngineState = initialEngineState(),
  config: AlertConfig = DEFAULT_ALERT_CONFIG,
  rules: readonly Rule[] = ALL_RULES,
): Evaluation {
  const metrics = computeMetrics(snapshot)
  const hfHistory = pushHf(
    state.hfHistory,
    snapshot.ts,
    metrics.healthFactor,
    config.cushionBurn?.lookbackS ?? 0,
  )
  const burnCfg = config.exitCapacity?.burn
  const fresh = burnCfg
    ? (ctx.capacity ?? []).filter(
        (r) =>
          Number.isFinite(r.availableUsd) &&
          snapshot.ts - r.asOf <= (config.exitCapacity?.maxAgeS ?? 0),
      )
    : []
  const capHistory = fresh.length
    ? pushHf(
        state.capHistory ?? [],
        snapshot.ts,
        fresh.reduce((a, r) => a + Math.max(0, r.availableUsd), 0),
        burnCfg?.lookbackS ?? 0,
      )
    : (state.capHistory ?? [])
  const trackers = { ...state.trackers }
  const alerts: Alert[] = []
  const uncovered: string[] = []

  for (const rule of rules) {
    for (const sig of rule.evaluate({ snapshot, metrics, ctx, hfHistory, capHistory, config })) {
      const id = `${rule.id}:${sig.key}`
      if (sig.value === null || Number.isNaN(sig.value)) {
        uncovered.push(`${id} — ${sig.uncoveredReason ?? 'no data'}`)
        continue
      }
      const step = stepLevel(sig.spec, trackers[id] ?? initialTracker(), sig.value, snapshot.ts)
      trackers[id] = step.state
      const t = step.transition
      if (!t) continue
      const recovering = t.kind === 'clear' || t.kind === 'ease'
      const severity = severityOf(recovering ? t.from : t.to)
      if (!severity) continue
      const words = sig.describe(t)
      alerts.push({
        positionId: snapshot.id,
        ruleId: rule.id,
        key: sig.key,
        transition: t.kind,
        from: t.from,
        to: t.to,
        severity,
        peak: t.peak,
        ts: snapshot.ts,
        value: sig.value,
        threshold: t.threshold,
        title: words.title,
        detail: words.detail,
        evidence: sig.evidence,
      })
    }
  }
  return { alerts, state: { trackers, hfHistory, capHistory }, metrics, uncovered }
}

/**
 * Whether an alert is worth a message. Fires and escalations at or above `minSeverity`
 * are. A clear is sent only when the episode reached warn (and `minSeverity`) — an
 * all-clear for a watch nobody acted on is noise. Eases and cooldown-suppressed
 * re-entries stay silent. Delivery passes DEFAULT_PUSH_MIN_SEVERITY; the back-test scores
 * every level, so it uses the 'watch' default.
 */
export function isNotifiable(a: Alert, minSeverity: Severity = 'watch'): boolean {
  const min = levelOf(minSeverity)
  if (a.transition === 'fire' || a.transition === 'escalate') return a.to >= min
  if (a.transition === 'clear') return a.peak >= Math.max(2, min)
  return false
}
